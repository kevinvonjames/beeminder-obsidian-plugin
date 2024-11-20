import { Plugin, PluginSettingTab, Setting, App, TFile, WorkspaceLeaf, Modal, debounce, Notice } from "obsidian";
import moment from 'moment-timezone';
import { Queue } from './queue'; // We'll create this file next

// Add this utility function at the top of your file
function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. Extend the Settings Interface
interface BeeminderSettings {
    apiKey: string;
    username: string;
    timezone: string;
    dayEndTime: string; // in 24-hour format, e.g., "06:00"
    dayEndMinute: number;
    goals: Array<{
        slug: string;
        filePath: string;
        isAutoSubmit: boolean;
        metricType: 'wordCount' | 'completedTasks' | 'uncompletedTasks';
        pollingFrequency: {
            hours: number;
            minutes: number;
            seconds: number;
        };
    }>;
    dayEndHour: number;
    dailyNoteGoals: Array<{
        slug: string;
        isAutoSubmit: boolean;
        metricType: 'wordCount' | 'completedTasks' | 'uncompletedTasks';
        pollingFrequency: {
            hours: number;
            minutes: number;
            seconds: number;
        };
    }>;
}

const DEFAULT_SETTINGS: BeeminderSettings = {
    apiKey: '',
    username: '',
    timezone: '', // Add this if it's not already present
    dayEndTime: '00:00', // Add this line
    dayEndHour: 0, // Add this line
    dayEndMinute: 0, // Add this line
    goals: [], // Add this if it's not already present
    dailyNoteGoals: [],
};

const validateTime = (hours: number, minutes: number): boolean => {
    if (hours === 6 && minutes > 0) {
        return false;
    }
    return true;
};

const formatTime = (hours: number, minutes: number): string => {
    return moment({ hours, minutes }).format('HH:mm');
};

const setDayEndTime = (hours: number, minutes: number) => {
    if (validateTime(hours, minutes)) {
        const time = formatTime(hours, minutes);
        // Save the time to your settings
        // Update your UI or perform any other necessary actions
    } else {
        new Notice('Invalid time. Please choose between 00:00-06:00 or 07:00-23:59.');
    }
};

// When calculating the target date for Beeminder
const getTargetDate = (dayEndTime: string): string => {
    const now = moment();
    const endTime = moment(dayEndTime, 'HH:mm');
    
    let targetDate = now.clone();
    if (now.hour() < endTime.hour() || (now.hour() === endTime.hour() && now.minute() < endTime.minute())) {
        targetDate.subtract(1, 'day');
    }

    return targetDate.format('YYYY-MM-DD');
};

export default class ExamplePlugin extends Plugin {
    settings: BeeminderSettings;
    private intervalIds: { [key: string]: number } = {};
    private updateQueue: Queue<string>;
    private isProcessingQueue: boolean;
    private dailyNoteIntervalIds: { [key: string]: number } = {};

    async onload() {
        console.log("Hello world");

        // Load settings
        await this.loadSettings();

        // Add settings tab
        this.addSettingTab(new BeeminderSettingTab(this.app, this));

        // Update commands
        this.updateCommands();

        this.updateQueue = new Queue<string>();
        this.isProcessingQueue = false;

        // Set up interval for automatic submissions if enabled
        this.setupAutoSubmit();
        this.startQueueProcessor();

        // Set up interval for automatic submissions for daily notes if enabled
        this.setupDailyNoteAutoSubmit();
    }

    onunload() {
        // Clear all intervals when the plugin is disabled
        Object.values(this.intervalIds).forEach(clearInterval);
        Object.values(this.dailyNoteIntervalIds).forEach(clearInterval);
        console.log("Goodbye world");
    }

    private startQueueProcessor() {
        setInterval(() => {
            this.processQueue();
        }, 10000); // Check queue every 5 seconds
    }

    private async processQueue() {
        if (this.isProcessingQueue || this.updateQueue.isEmpty()) {
            return;
        }

        this.isProcessingQueue = true;
        const filePath = this.updateQueue.dequeue();
        if (filePath) {
            await this.checkAndUpdateBeeminder(filePath);
        }
        this.isProcessingQueue = false;
    }

    private async manualSubmitDatapoint(goalIndex?: number) {
        if (goalIndex !== undefined && goalIndex < this.settings.goals.length) {
            const goal = this.settings.goals[goalIndex];
            this.updateQueue.enqueue(goal.filePath);
        } else {
            // If no specific goal is specified, update all goals
            for (const goal of this.settings.goals) {
                this.updateQueue.enqueue(goal.filePath);
            }
        }
    }

    private setupAutoSubmit() {
        // Clear all existing intervals
        Object.values(this.intervalIds).forEach(clearInterval);
        this.intervalIds = {};

        // Set up new intervals for each auto-submit goal
        this.settings.goals.forEach((goal, index) => {
            if (goal.isAutoSubmit) {
                const totalMilliseconds = 
                    (goal.pollingFrequency.hours * 3600 +
                     goal.pollingFrequency.minutes * 60 +
                     goal.pollingFrequency.seconds) * 1000;
                
                this.intervalIds[goal.slug] = window.setInterval(() => {
                    this.autoSubmitDatapoint(index);
                }, totalMilliseconds);
            }
        });
    }

    private async autoSubmitDatapoint(goalIndex: number) {
        const goal = this.settings.goals[goalIndex];
        console.log(`Auto-submitting datapoint for goal: ${goal.slug}`);
        this.updateQueue.enqueue(goal.filePath);
    }

    // Modify the checkAndUpdateBeeminder method
    private checkAndUpdateBeeminder = async (filePath: string) => {
        const goal = this.settings.goals.find(g => g.filePath === filePath);
        if (goal) {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                // Wait for 3 seconds before reading the file
                await delay(3000);
                
                const fileContent = await this.app.vault.read(file);
                let value: number;
                switch (goal.metricType) {
                    case 'wordCount':
                        value = fileContent.split(/\s+/).length;
                        break;
                    case 'completedTasks':
                        value = fileContent.split(/\r?\n/).filter(line => line.trim().startsWith("- [x]")).length;
                        break;
                    case 'uncompletedTasks':
                        value = fileContent.split(/\r?\n/).filter(line => line.trim().startsWith("- [ ]")).length;
                        break;
                    default:
                        console.error(`Unknown metric type: ${goal.metricType}`);
                        return;
                }

                const lastDatapoint = await this.getBeeminderLastDatapoint(goal.slug);
                if (value !== lastDatapoint.value) {
                    await this.pushBeeminderDataPoint(value, goal.slug, file);
                } else {
                    console.log(`No update needed for ${goal.slug}. Current value: ${value}`);
                }
            }
        }
    };

    // Replace getBeeminderCurrentValue with this new method
    private async getBeeminderLastDatapoint(goalSlug: string): Promise<{ value: number, daystamp: string, id: string } | null> {
        const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}/datapoints.json?auth_token=${this.settings.apiKey}&count=1`);
        const data = await response.json();
        if (data.length > 0) {
            return { value: data[0].value, daystamp: data[0].daystamp, id: data[0].id };
        }
        return null;
    }

    private async pushBeeminderDataPoint(value: number, goalSlug: string, file: TFile) {
        console.log("Starting pushBeeminderDataPoint");
        console.log("Value:", value, "Goal slug:", goalSlug);
        console.log("File:", file);

        const now = moment.tz(this.settings.timezone);
        console.log("Current time:", now.format());

        const todayEndTime = moment.tz(now.format('YYYY-MM-DD') + ' ' + this.settings.dayEndTime, 'YYYY-MM-DD HH:mm', this.settings.timezone);
        console.log("Today's end time:", todayEndTime.format());
        
        let targetDate = now.clone();

        if (todayEndTime.hour() >= 0 && todayEndTime.hour() <= 6 && now.isBefore(todayEndTime)) {
            console.log("Night Owl Zone: subtracting 1 day");
            targetDate.subtract(1, 'day');
        }

        const formattedDate = targetDate.format('YYYY-MM-DD');
        console.log("Formatted date for Beeminder:", formattedDate);

        const comment = `Updated from ${file.path} in Obsidian at ${now.format('HH:mm:ss')} ${this.settings.timezone}`;
        console.log("Generated comment:", comment);

        console.log(`Pushing datapoint for date: ${formattedDate}, current time: ${now.format()}, day end time: ${todayEndTime.format()}`);

        try {
            const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}/datapoints.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    auth_token: this.settings.apiKey,
                    value: value,
                    comment: comment,
                    daystamp: formattedDate
                })
            });
            const data = await response.json();
            console.log("Data pushed to Beeminder:", data);
        } catch (error) {
            console.error("Error pushing data to Beeminder:", error);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.setupAutoSubmit();
        this.setupDailyNoteAutoSubmit();
        this.updateCommands(); // Add this line
    }

    // Add this new method
    private updateCommands() {
        // Remove existing commands
        this.removeCommand(`submit-beeminder-datapoint-all`);
        for (let i = 1; i <= 10; i++) {
            this.removeCommand(`submit-beeminder-datapoint-goal-${i}`);
        }
        this.removeCommand(`submit-beeminder-datapoint-daily-note-all`);
        for (let i = 1; i <= 10; i++) {
            this.removeCommand(`submit-beeminder-datapoint-daily-note-goal-${i}`);
        }

        // Add command for submitting all regular goals
        this.addCommand({
            id: 'submit-beeminder-datapoint-all',
            name: 'Submit Beeminder Datapoint for All Regular Goals',
            callback: () => this.manualSubmitDatapoint(),
        });

        // Add commands for individual regular goals
        this.settings.goals.forEach((goal, index) => {
            if (index < 10) {
                this.addCommand({
                    id: `submit-beeminder-datapoint-goal-${index + 1}`,
                    name: `Submit Beeminder Datapoint for ${goal.slug || `Goal ${index + 1}`}`,
                    callback: () => this.manualSubmitDatapoint(index),
                });
            }
        });

        // Add command for submitting all daily note goals
        this.addCommand({
            id: 'submit-beeminder-datapoint-daily-note-all',
            name: 'Submit Beeminder Datapoint for All Daily Note Goals',
            callback: () => this.manualSubmitDailyNoteDatapoint(),
        });

        // Add commands for individual daily note goals
        this.settings.dailyNoteGoals.forEach((goal, index) => {
            if (index < 10) {
                this.addCommand({
                    id: `submit-beeminder-datapoint-daily-note-goal-${index + 1}`,
                    name: `Submit Beeminder Datapoint for Daily Note Goal ${goal.slug || `${index + 1}`}`,
                    callback: () => this.manualSubmitDailyNoteDatapoint(index),
                });
            }
        });
    }

    private setupDailyNoteAutoSubmit() {
        // Clear all existing intervals for daily notes
        Object.values(this.dailyNoteIntervalIds).forEach(clearInterval);
        this.dailyNoteIntervalIds = {};

        // Set up new intervals for each auto-submit daily note goal
        this.settings.dailyNoteGoals.forEach((goal, index) => {
            if (goal.isAutoSubmit) {
                const totalMilliseconds = 
                    (goal.pollingFrequency.hours * 3600 +
                     goal.pollingFrequency.minutes * 60 +
                     goal.pollingFrequency.seconds) * 1000;
                
                this.dailyNoteIntervalIds[goal.slug] = window.setInterval(() => {
                    this.autoSubmitDailyNoteDatapoint(index);
                }, totalMilliseconds);
            }
        });
    }

    private async autoSubmitDailyNoteDatapoint(goalIndex: number) {
        const goal = this.settings.dailyNoteGoals[goalIndex];
        console.log(`Auto-submitting datapoint for daily note goal: ${goal.slug}`);
        await this.checkAndUpdateDailyNoteBeeminder(goal);
    }

    private async checkAndUpdateDailyNoteBeeminder(goal: BeeminderSettings['dailyNoteGoals'][0]) {
        console.log("Starting checkAndUpdateDailyNoteBeeminder for goal:", goal);
        const dailyNote = await this.getDailyNote();
        if (!dailyNote) {
            console.error("Could not get daily note");
            return;
        }

        try {
            const fileContent = await this.app.vault.read(dailyNote);
            let value: number;
            switch (goal.metricType) {
                case 'wordCount':
                    value = fileContent.split(/\s+/).length;
                    break;
                case 'completedTasks':
                    value = fileContent.split(/\r?\n/).filter(line => line.trim().startsWith("- [x]")).length;
                    break;
                case 'uncompletedTasks':
                    value = fileContent.split(/\r?\n/).filter(line => line.trim().startsWith("- [ ]")).length;
                    break;
                default:
                    console.error(`Unknown metric type: ${goal.metricType}`);
                    return;
            }

            const lastDatapoint = await this.getBeeminderLastDatapoint(goal.slug);
            
            if (lastDatapoint && value === lastDatapoint.value) {
                console.log("No update needed. Current value matches Beeminder datapoint.");
                return;
            }

            await this.pushBeeminderDataPoint(value, goal.slug, dailyNote);
            console.log("Datapoint pushed to Beeminder");
        } catch (error) {
            console.error("Error processing daily note:", error);
        }
    }

    private getDailyNotePath(date: moment.Moment): string | null {
        const dailyNotesPlugin = (this.app as any).internalPlugins.plugins['daily-notes'];
        if (dailyNotesPlugin && dailyNotesPlugin.enabled) {
            const format = dailyNotesPlugin.instance.options?.format || "YYYY-MM-DD";
            const fileName = date.format(format) + ".md";
            return dailyNotesPlugin.instance.options?.folder
                ? `${dailyNotesPlugin.instance.options.folder}/${fileName}`
                : fileName;
        }
        return null;
    }

    private async getDailyNote(): Promise<TFile | null> {
        console.log("Starting getDailyNote method");
        const now = moment().tz(this.settings.timezone);
        console.log("Current moment:", now.format());

        console.log("Getting day end time");
        const dayEndTime = moment.tz(now.format('YYYY-MM-DD') + ' ' + this.settings.dayEndTime, 'YYYY-MM-DD HH:mm', this.settings.timezone);
        console.log("Day end time:", dayEndTime.format());

        let targetDate = now.clone();
        if (dayEndTime.hour() >= 0 && dayEndTime.hour() <= 6 && now.isBefore(dayEndTime)) {
            console.log("Night Owl Zone: subtracting 1 day");
            targetDate.subtract(1, 'day');
        }
        console.log("Target date:", targetDate.format());

        const filePath = this.getDailyNotePath(targetDate);
        console.log("Calculated file path:", filePath);

        if (filePath) {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                console.log("Daily note found:", file.path);
                return file;
            }
        }

        console.log("Daily note not found");
        return null;
    }

    private getCurrentDateForBeeminder(): string {
        const now = moment.tz(this.settings.timezone);
        const todayEndTime = moment.tz(now.format('YYYY-MM-DD') + ' ' + this.settings.dayEndTime, 'YYYY-MM-DD HH:mm', this.settings.timezone);
        
        let targetDate = now.clone();

        // Night Owl Zone
        if (todayEndTime.hour() >= 0 && todayEndTime.hour() <= 6 && now.isBefore(todayEndTime)) {
            targetDate.subtract(1, 'day');
        }

        return targetDate.format('YYYY-MM-DD');
    }

    private async getBeeminderDatapointForDate(goalSlug: string, date: string): Promise<{ id: string, value: number } | null> {
        const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}/datapoints.json?auth_token=${this.settings.apiKey}&daystamp=${date}`);
        const data = await response.json();
        if (data.length > 0) {
            return { id: data[0].id, value: data[0].value };
        }
        return null;
    }

    private async updateBeeminderDatapoint(goalSlug: string, datapointId: string, value: number, file: TFile) { 
        const now = moment.tz(this.settings.timezone);
        const comment = `Updated from ${file.path} in Obsidian at ${now.format('HH:mm:ss')} ${this.settings.timezone}`;

        const response = await fetch(`https://www.beeminder.com/api/v1/users/${this.settings.username}/goals/${goalSlug}/datapoints/${datapointId}.json`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                auth_token: this.settings.apiKey,
                value: value,
                comment: comment
            })
        });
        const data = await response.json();
        console.log("Datapoint updated in Beeminder:", data);
    }

    private async manualSubmitDailyNoteDatapoint(goalIndex?: number) {
        if (goalIndex !== undefined && goalIndex < this.settings.dailyNoteGoals.length) {
            const goal = this.settings.dailyNoteGoals[goalIndex];
            await this.checkAndUpdateDailyNoteBeeminder(goal);
        } else {
            // If no specific goal is specified, update all daily note goals
            for (const goal of this.settings.dailyNoteGoals) {
                await this.checkAndUpdateDailyNoteBeeminder(goal);
            }
        }
    }
}

class BeeminderSettingTab extends PluginSettingTab {
    plugin: ExamplePlugin;
    currentTimeDisplay: HTMLElement;

    constructor(app: App, plugin: ExamplePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Beeminder API Key')
            .setDesc('Enter your Beeminder API key.')
            .addText(text => text
                .setPlaceholder('api-key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Beeminder Username')
            .setDesc('Enter your Beeminder username.')
            .addText(text => text
                .setPlaceholder('username')
                .setValue(this.plugin.settings.username)
                .onChange(async (value) => {
                    this.plugin.settings.username = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Timezone')
            .setDesc('Select your timezone')
            .addDropdown(dropdown => {
                // Populate dropdown with timezones
                moment.tz.names().forEach(tz => {
                    dropdown.addOption(tz, tz);
                });
                dropdown.setValue(this.plugin.settings.timezone)
                    .onChange(async (value) => {
                        this.plugin.settings.timezone = value;
                        await this.plugin.saveSettings();
                    });
            });

        let hourValue = this.plugin.settings.dayEndHour ?? 0;
        let minuteValue = this.plugin.settings.dayEndMinute ?? 0;

        // Create sliders for hour and minute
        new Setting(containerEl)
            .setName('Day End Time')
            .setDesc('Set the end time for your Beeminder day (7:00 AM to 6:00 AM)')
            .addSlider(slider => slider
                .setLimits(0, 23, 1)
                .setValue(hourValue)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    hourValue = value;
                    if (validateTime(hourValue, minuteValue)) {
                        this.plugin.settings.dayEndHour = value;
                        this.plugin.settings.dayEndTime = formatTime(hourValue, minuteValue);
                        await this.plugin.saveSettings();
                        this.updateCurrentTimeDisplay(hourValue, minuteValue);
                    } else {
                        new Notice('Invalid time. Please choose between 00:00-06:00 or 07:00-23:59.');
                    }
                }))
            .addSlider(slider => slider
                .setLimits(0, 59, 1)
                .setValue(minuteValue)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    minuteValue = value;
                    if (validateTime(hourValue, minuteValue)) {
                        this.plugin.settings.dayEndMinute = value;
                        this.plugin.settings.dayEndTime = formatTime(hourValue, minuteValue);
                        await this.plugin.saveSettings();
                        this.updateCurrentTimeDisplay(hourValue, minuteValue);
                    } else {
                        new Notice('Invalid time. Please choose between 00:00-06:00 or 07:00-23:59.');
                    }
                }));

        // Create a new setting for the current time display
        new Setting(containerEl)
            .setName('Current Day End Time')
            .setDesc('The currently set day end time is:')
            .addText(text => {
                this.currentTimeDisplay = text.inputEl;
                text.setDisabled(true);
                this.updateCurrentTimeDisplay(hourValue, minuteValue);
            });

        containerEl.createEl('p', {text: 'Note: Deadlines from 07:00 to 23:59 are considered "Early Bird" deadlines for the current day. Deadlines from 00:00 to 06:00 are "Night Owl" deadlines, technically for the next day. The time range 06:01-06:59 is not allowed.'});

        containerEl.createEl('h3', {text: 'Goals and File Paths'});

        this.plugin.settings.goals.forEach((goal, index) => {
            const goalContainer = containerEl.createDiv();

            new Setting(goalContainer)
                .setName(`Goal ${index + 1}`)
                .addText(text => text
                    .setPlaceholder('goal-slug')
                    .setValue(goal.slug)
                    .onChange(async (value) => {
                        goal.slug = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder('file/path.md')
                    .setValue(goal.filePath)
                    .onChange(async (value) => {
                        goal.filePath = value;
                        await this.plugin.saveSettings();
                    }))
                .addDropdown(dropdown => dropdown
                    .addOption('wordCount', 'Word Count')
                    .addOption('completedTasks', 'Completed Tasks')
                    .addOption('uncompletedTasks', 'Uncompleted Tasks')
                    .setValue(goal.metricType)
                    .onChange(async (value: 'wordCount' | 'completedTasks' | 'uncompletedTasks') => {
                        goal.metricType = value;
                        await this.plugin.saveSettings();
                    }))
                .addToggle(toggle => toggle
                    .setValue(goal.isAutoSubmit)
                    .setTooltip('Toggle automatic submission')
                    .onChange(async (value) => {
                        goal.isAutoSubmit = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }))
                .addButton(button => button
                    .setButtonText('Remove')
                    .onClick(async () => {
                        this.plugin.settings.goals.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            if (goal.isAutoSubmit) {
                new Setting(goalContainer)
                    .setName('Polling Frequency')
                    .addText(text => text
                        .setPlaceholder('HH:MM:SS')
                        .setValue(`${goal.pollingFrequency.hours.toString().padStart(2, '0')}:${goal.pollingFrequency.minutes.toString().padStart(2, '0')}:${goal.pollingFrequency.seconds.toString().padStart(2, '0')}`)
                        .onChange(async (value) => {
                            const [hours, minutes, seconds] = value.split(':').map(Number);
                            goal.pollingFrequency = { hours, minutes, seconds };
                            await this.plugin.saveSettings();
                        }));
            }
        });

        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('Add Goal')
                .onClick(async () => {
                    this.plugin.settings.goals.push({
                        slug: '',
                        filePath: '',
                        isAutoSubmit: false,
                        metricType: 'wordCount', // Default to word count
                        pollingFrequency: { hours: 0, minutes: 5, seconds: 0 }
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));

        this.addHotkeySection(containerEl);

        this.addDailyNoteGoalsSection(containerEl);
    }

    updateCurrentTimeDisplay(hours: number, minutes: number) {
        if (this.currentTimeDisplay) {
            (this.currentTimeDisplay as HTMLInputElement).value = formatTime(hours, minutes);
        }
    }

    addHotkeySection(containerEl: HTMLElement) {
        containerEl.createEl('h3', {text: 'Hotkeys'});

        for (let i = 1; i <= 10; i++) {
            new Setting(containerEl)
                .setName(`Goal ${i} Hotkey`)
                .setDesc(`Hotkey to submit data for Goal ${i}`)
                .addButton(button => button
                    .setButtonText('Go to Hotkeys')
                    .onClick(() => {
                        (this.app as any).setting.open();
                        (this.app as any).setting.openTabById('hotkeys');
                        setTimeout(() => {
                            const hotkeySetting = document.querySelector(`[data-hotkey-id="beeminder-obsidian:submit-beeminder-datapoint-goal-${i}"]`);
                            if (hotkeySetting) {
                                hotkeySetting.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }, 300);
                    }));
        }
    }

    addDailyNoteGoalsSection(containerEl: HTMLElement) {
        containerEl.createEl('h3', {text: 'Daily Note Goals'});

        this.plugin.settings.dailyNoteGoals.forEach((goal, index) => {
            const goalContainer = containerEl.createDiv();

            new Setting(goalContainer)
                .setName(`Daily Note Goal ${index + 1}`)
                .addText(text => text
                    .setPlaceholder('goal-slug')
                    .setValue(goal.slug)
                    .onChange(async (value) => {
                        goal.slug = value;
                        await this.plugin.saveSettings();
                    }))
                .addDropdown(dropdown => dropdown
                    .addOption('wordCount', 'Word Count')
                    .addOption('completedTasks', 'Completed Tasks')
                    .addOption('uncompletedTasks', 'Uncompleted Tasks')
                    .setValue(goal.metricType)
                    .onChange(async (value: 'wordCount' | 'completedTasks' | 'uncompletedTasks') => {
                        goal.metricType = value;
                        await this.plugin.saveSettings();
                    }))
                .addToggle(toggle => toggle
                    .setValue(goal.isAutoSubmit)
                    .setTooltip('Toggle automatic submission')
                    .onChange(async (value) => {
                        goal.isAutoSubmit = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }))
                .addButton(button => button
                    .setButtonText('Remove')
                    .onClick(async () => {
                        this.plugin.settings.dailyNoteGoals.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            if (goal.isAutoSubmit) {
                new Setting(goalContainer)
                    .setName('Polling Frequency')
                    .addText(text => text
                        .setPlaceholder('HH:MM:SS')
                        .setValue(`${goal.pollingFrequency.hours.toString().padStart(2, '0')}:${goal.pollingFrequency.minutes.toString().padStart(2, '0')}:${goal.pollingFrequency.seconds.toString().padStart(2, '0')}`)
                        .onChange(async (value) => {
                            const [hours, minutes, seconds] = value.split(':').map(Number);
                            goal.pollingFrequency = { hours, minutes, seconds };
                            await this.plugin.saveSettings();
                        }));
            }
        });

        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('Add Daily Note Goal')
                .onClick(async () => {
                    this.plugin.settings.dailyNoteGoals.push({
                        slug: '',
                        isAutoSubmit: false,
                        metricType: 'wordCount',
                        pollingFrequency: { hours: 0, minutes: 5, seconds: 0 }
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }
}