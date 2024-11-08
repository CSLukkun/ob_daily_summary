import { App, Plugin, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from './setting';
import moment from 'moment';
export default class DailyDigestPlugin extends Plugin {
    settings: PluginSettings;

    async onload() {
        await this.loadSettings();

        // 添加设置选项卡
        this.addSettingTab(new DailyDigestSettingTab(this.app, this));

        // 添加命令
        this.addCommand({
            id: 'generate-daily-report',
            name: 'Generate Daily Report',
            callback: () => this.generateDailyReport(0)
        });

        this.addCommand({
            id: 'generate-previous-day-report',
            name: 'Generate Previous Day Report',
            callback: () => {
                const modal = new DaysSelectionModal(this.app, async (days: number) => {
                    if (days > 0) days = -days;
                    await this.generateDailyReport(days);
                });
                modal.open();
            }
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async generateDailyReport(daysOffset: number = 0) {
        try {
            const targetDate = moment().add(daysOffset, 'days');
            const dateStr = targetDate.format('YYYY-MM-DD');

            // 获取指定日期的笔记
            const files = this.app.vault.getMarkdownFiles();
            const todayNotes = files.filter(file => {
                const fileCreateDate = moment(file.stat.ctime).format('YYYY-MM-DD');
                const fileModifyDate = moment(file.stat.mtime).format('YYYY-MM-DD');
                return fileCreateDate === dateStr || fileModifyDate === dateStr;
            });
            new Notice(`找到 ${todayNotes.length} 篇笔记`);

            if (todayNotes.length === 0) {
                new Notice(`没有找到 ${dateStr} 的笔记`);
                return;
            }

            // 调用 LLM
            const prompt = await this.generatePrompt(todayNotes);

            const summary = await this.callLLM(prompt);

            if (!summary) {
                new Notice('Failed to generate summary');
                return;
            }

            // 创建报告
            await this.createDailyReport(dateStr, summary);
            new Notice('Daily report generated successfully!');

        } catch (error) {
            await this.logError(error, 'Fail to generate report');
            console.error('Error generating daily report:', error);
            new Notice(`Error: ${error.message}`);
        }
    }

    async getTodayNotes() {
        try {
            const files = this.app.vault.getMarkdownFiles();
            const today = moment().format('YYYY-MM-DD');


            const todayNotes = files.filter(file => {
                // 检查文件名中的日期
                const fileNameDate = this.getDateFromFileName(file.name);
                if (fileNameDate === today) return true;

                // 检查文件创建/修改时间
                const fileCreateDate = moment(file.stat.ctime).format('YYYY-MM-DD');
                const fileModifyDate = moment(file.stat.mtime).format('YYYY-MM-DD');
                return fileCreateDate === today || fileModifyDate === today;
            });

            return todayNotes;

        } catch (error) {
            throw error;
        }
    }

    async callLLM(prompt: string) {
        try {

            const response = await fetch(this.settings.apiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.7
                })
            });


            if (!response.ok) {
                const errorText = await response.text();
                console.error('API response error:', errorText);
                throw new Error(`API request failed: ${response.status} ${errorText}`);
            }

            const data = await response.json();

            return data.choices?.[0]?.message?.content || '';

        } catch (error) {
            await this.logError(error, 'Fail to call LLM API');
            throw new Error(`Fail to call LLM API: ${error.message}`);
        }
    }

    async createDailyReport(date: string, content: string) {
        try {
            const fileName = `${this.settings.reportLocation}/Daily Report-${date}.md`.replace('//', '/');

            // 检查文件是否已存在
            if (await this.app.vault.adapter.exists(fileName)) {
                // 如果文件存在，追加内容或更新内容
                const existingContent = await this.app.vault.adapter.read(fileName);
                const newContent = `${existingContent}\n\n## 更新于 ${new Date().toLocaleTimeString()}\n\n${content}`;
                await this.app.vault.adapter.write(fileName, newContent);
            } else {
                // 如果文件不存在，创建新文件
                const fileContent = `# ${date} 日报\n\n${content}`;
                await this.app.vault.create(fileName, fileContent);
            }

        } catch (error) {
            console.error('Fail to create/update report file:', error);
            throw new Error(`Fail to create/update file: ${error.message}`);
        }
    }

    private getDateFromFileName(fileName: string): string {
        // 根据你的文件命名规则来实现
        // 例如: "2024-03-20.md" => "2024-03-20"
        const match = fileName.match(/(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
    }

    private async generatePrompt(notes: any[]): Promise<string> {
        try {
            // 等待所有笔记内容读取完成
            const notesContents = await Promise.all(
                notes.map(async note => {
                    const content = await this.app.vault.read(note);
                    return `${note.name}:\n${content}`;
                })
            );

            // 将所有笔记内容合并
            const allContent = notesContents.join('\n\n');

            return `Please summarize the main content of today's notes:\n\n${allContent}`;
        } catch (error) {
            console.error('Fail to generate prompt:', error);
            throw new Error(`Fail to generate prompt: ${error.message}`);
        }
    }

    private async logError(error: any, context: string) {
        try {
            const time = new Date().toISOString();
            const errorLog = `
[${time}] ${context}
Error message: ${error.message}
Stack trace: ${error.stack}
API configuration: 
- endpoint: ${this.settings.apiEndpoint || 'Not set'}
- apiKey: ${this.settings.apiKey ? 'Set' : 'Not set'}
-------------------
`;
            const logFile = `${this.settings.reportLocation}/debug-errors.md`;

            // 检查文件是否存在
            let content = errorLog;
            if (await this.app.vault.adapter.exists(logFile)) {
                const existingContent = await this.app.vault.adapter.read(logFile);
                content = existingContent + '\n' + errorLog;
            }

            await this.app.vault.adapter.write(logFile, content);
            console.error('Error logged to:', logFile);
        } catch (logError) {
            console.error('Fail to write error log:', logError);
        }
    }
}

// 添加设置界面
class DailyDigestSettingTab extends PluginSettingTab {
    plugin: DailyDigestPlugin;

    constructor(app: App, plugin: DailyDigestPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('Enter your LLM API Key')
            .addText(text => text
                .setPlaceholder('Enter API Key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Endpoint')
            .setDesc('Enter API endpoint address')
            .addText(text => text
                .setPlaceholder('https://api.example.com/v1/chat')
                .setValue(this.plugin.settings.apiEndpoint)
                .onChange(async (value) => {
                    this.plugin.settings.apiEndpoint = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Report save location')
            .setDesc('Set the folder path to save the report (e.g., /Reports or /Daily)')
            .addText(text => text
                .setPlaceholder('/')
                .setValue(this.plugin.settings.reportLocation)
                .onChange(async (value) => {
                    this.plugin.settings.reportLocation = value;
                    await this.plugin.saveSettings();
                }));
    }
}

// 添加一个选择天数的模态框
class DaysSelectionModal extends Modal {
    private daysCallback: (days: number) => void;

    constructor(app: App, callback: (days: number) => void) {
        super(app);
        this.daysCallback = callback;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: '选择要生成报告的天数' });

        const inputEl = contentEl.createEl('input', {
            type: 'number',
            value: '1',
            attr: {
                min: '1',
                max: '30'  // 设置最大值防止选择太久远的日期
            }
        });

        const buttonEl = contentEl.createEl('button', {
            text: '确认'
        });

        buttonEl.onclick = () => {
            const days = parseInt(inputEl.value);
            if (!isNaN(days) && days > 0) {
                this.daysCallback(days);
                this.close();
            }
        };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}