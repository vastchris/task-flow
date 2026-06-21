import { App, Editor, ItemView, MarkdownView, Menu, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { buildMonthWeeks, CalendarWeek, computeWeekKey, formatDateKey } from "./calendar";
import { MonthlyFile, parseMonthlyFileName } from "./monthlyFile";
import {
  addDayTaskToWeek,
  addDayTasksToWeek,
  addWeekTaskToDay,
  addWeekTasksToDay,
  continueDayTask,
  createChildTask,
  taskHasContinuedInstance,
  createTopLevelTask
} from "./structure/v2Created";
import {
  deleteProjectionDescendants,
  deleteTask,
  deleteTasks,
  getDeletionPreview,
  getBatchDeletionPreview,
  getDeletionTasklogIds,
  getProjectionDeletionTasklogIds,
  DeletionPreview
} from "./structure/v2Deleted";
import {
  renameTask,
  renameTagInTasks,
  reorderTask,
  reorderTagGroups,
  moveDayTask,
  moveProjectionChildren
} from "./structure/v2Modified";
import {
  applyDayTaskStatusChanges,
  changeDayTaskStatus,
  runStatusDocumentOperation
} from "./structure/v2Status";
import { taskIdentityKey } from "./structure/v2TaskGroups";
import { findTasklog, hasDayBlock, hasWeekBlock, orphanTasklog } from "./structure/v2Document";
import { findOrderItem, flattenOrderArray, getDayTaskIds, getWeekTaskIds, MonthTaskData, TaskArea, TaskOrderItem, TaskRecord, TaskTags } from "./store/v2Schema";
import { TaskStatus } from "./store/v2Schema";
import { isValidSingleTag, parseStoredTaskName } from "./taskTags";
import { TaskFlowV2Store } from "./store/v2Store";
import { createEmptyMonthTaskData } from "./store/v2Defaults";
import {
  buildPriorUnfinishedSections,
  buildTaskTree,
  buildWeekTaskTree,
  groupSourceContexts,
  PriorUnfinishedSection,
  TaskProgress
} from "./taskProjection";

export const TASK_FLOW_VIEW_TYPE = "task-flow-view";
const PRIOR_UNFINISHED_EXPANDED_HEIGHT = 300;

type SectionKind = "week" | "day";
type TimePickerMode = "week" | "month" | "year";
type ViewTimeContext = {
  month: MonthlyFile;
  weeks: CalendarWeek[];
  selectedWeek: CalendarWeek;
  selectedDay: CalendarWeek["days"][number];
};
type ContextMenuItem = {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};
type TagMenuContext = {
  sectionId: SectionKind;
  level: "primary" | "secondary";
  primary: string;
  secondary?: string;
};
type TagSortGroup = {
  primary: string;
  secondaries: string[];
};
interface DemoTask {
  id: string;
  actionTaskId?: string;
  name: string;
  editName?: string;
  tags?: TaskTags;
  inlineTag?: string;
  status: TaskStatus;
  special?: boolean;
  children?: DemoTask[];
  isNewDayTask?: boolean;
  sourceHint?: string;
  sourceContextId?: string;
  isSourceGroup?: boolean;
  isDateGroup?: boolean;
  hasWeekSource?: boolean;
  isParentContext?: boolean;
  isWeekParent?: boolean;
  arrangementLabel?: string;
  legacyDateLabel?: string;
  progress?: TaskProgress;
  sourceLabel?: string;
}

const setTaskFlowJumpHighlight = StateEffect.define<{
  from: number;
  to: number;
} | null>();

const taskFlowJumpHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setTaskFlowJumpHighlight)) continue;
      decorations = effect.value
        ? Decoration.set([
          Decoration.mark({
            class: "task-flow-jump-highlight"
          }).range(effect.value.from, effect.value.to)
        ])
        : Decoration.none;
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const taskFlowJumpHighlightClearHandlers = new WeakMap<
  EditorView,
  (event: PointerEvent) => void
>();

export class TaskFlowView extends ItemView {
  private activeSection: SectionKind = "week";
  private switchingSection = false;
  private sectionSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  private priorUnfinishedSnapshot: {
    label: string;
    sections: PriorUnfinishedSection[];
  } | null = null;
  private selectedWeekKey: string | null = null;
  private selectedDayKey: string | null = null;
  private collapsedSections = new Set<string>();
  private weekTaskFilter: "pending" | "all" = "pending";
  private inputTarget: string | null = null;
  private tagCreatePrefix: string | null = null;
  private openProgressTaskId: string | null = null;
  private priorUnfinishedExpanded = false;
  private multiSelect: { sectionId: SectionKind; selectedKeys: Set<string> } | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private priorDockEl: HTMLElement | null = null;
  private customMenuEl: HTMLElement | null = null;
  private weekPickerEl: HTMLElement | null = null;
  private weekPickerCleanup: (() => void) | null = null;
  private weekPickerOpen = false;
  private weekPickerTrigger: "time" | "day-switch" = "time";
  private timePickerMode: TimePickerMode = "week";
  private timePickerBrowseMonth: MonthlyFile | null = null;
  private preserveWeekPickerDuringRender = false;
  private timeNavScrollLeft: Record<SectionKind, number> = { week: 0, day: 0 };
  private renderVersion = 0;
  private rendering = false;
  private suppressStoreRender = 0;
  private pendingStoreRender = false;
  private tasklogDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTasklogSet: Set<string> | null = null;
  private lastTasklogFilePath: string | null = null;
  private lastActiveMarkdownFile: TFile | null = null;
  private taskInputOverlayCleanup: (() => void) | null = null;
  private mobileScrollIsolationCleanup: (() => void) | null = null;
  private dragState: {
    taskId: string;
    actionTaskId: string;
    depth: number;
    sectionId: SectionKind;
    startY: number;
    row: HTMLElement;
  } | null = null;
  private dropIndicator: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly store: TaskFlowV2Store
  ) {
    super(leaf);
  }

  getViewType(): string {
    return TASK_FLOW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Task Flow";
  }

  getIcon(): string {
    return "list-checks";
  }

  async onOpen(): Promise<void> {
    this.lastActiveMarkdownFile = this.app.workspace.getActiveFile();
    this.unsubscribeStore = this.store.subscribe(() => {
      if (this.suppressStoreRender > 0) {
        this.pendingStoreRender = true;
        return;
      }
      void this.render();
    });
    void this.render();
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.handleActiveFileChanged(file)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf) return;
      const view = leaf?.view;
      if (view instanceof MarkdownView && view.file) {
        this.lastActiveMarkdownFile = view.file;
      }
      void this.render();
    }));
    this.registerDomEvent(window, "resize", () => {
      this.revealSelectedTimeChips();
      this.positionMobileBottomFade();
      if (this.priorDockEl) {
        this.positionPriorDock(this.priorDockEl);
      }
    });
    this.registerEvent(this.app.metadataCache.on("changed", (changedFile) => {
      const targetFile = this.getCurrentTargetMonthlyFile();
      if (!targetFile || changedFile.path !== targetFile.path) return;
      const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const editor = markdownView?.file?.path === targetFile.path
        ? markdownView.editor
        : undefined;
      this.debounceTasklogScan(targetFile, editor);
    }));
    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      const changedFile = info.file;
      const targetFile = this.getCurrentTargetMonthlyFile();
      if (!changedFile || !targetFile || changedFile.path !== targetFile.path) return;
      this.debounceTasklogScan(targetFile, editor);
    }));
  }

  async onClose(): Promise<void> {
    this.clearTaskInputOverlay();
    this.mobileScrollIsolationCleanup?.();
    this.mobileScrollIsolationCleanup = null;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    if (this.sectionSwitchTimer) {
      clearTimeout(this.sectionSwitchTimer);
      this.sectionSwitchTimer = null;
    }
    if (this.tasklogDebounceTimer) {
      clearTimeout(this.tasklogDebounceTimer);
      this.tasklogDebounceTimer = null;
    }
    this.lastTasklogSet = null;
    this.closeWeekPicker();
    this.removePriorDock();
    this.containerEl.empty();
  }

  private handleActiveFileChanged(file?: TFile | null): void {
    if (file) {
      this.lastActiveMarkdownFile = file;
    }
    if (this.sectionSwitchTimer) {
      clearTimeout(this.sectionSwitchTimer);
      this.sectionSwitchTimer = null;
    }
    this.switchingSection = false;
    this.inputTarget = null;
    this.tagCreatePrefix = null;
    this.openProgressTaskId = null;
    this.priorUnfinishedExpanded = false;
    this.multiSelect = null;
    this.weekPickerOpen = false;
    void this.render();
  }

  private resolveViewTime(): ViewTimeContext {
    if (!this.selectedWeekKey) {
      const today = new Date();
      const todayKey = formatDateKey(today);
      this.selectedWeekKey = computeWeekKey(todayKey);
      this.selectedDayKey = todayKey;
    }

    const month = monthFromWeekKey(this.selectedWeekKey);
    const weeks = buildMonthWeeks(month);
    const selectedWeek = weeks.find((week) => week.key === this.selectedWeekKey) ?? weeks[0];
    this.selectedWeekKey = selectedWeek.key;

    const selectedDay = selectedWeek.days.find((day) => day.key === this.selectedDayKey)
      ?? selectedWeek.days[0];
    this.selectedDayKey = selectedDay.key;

    return { month, weeks, selectedWeek, selectedDay };
  }

  private getCurrentTargetMonthlyFile(): TFile | null {
    const { month } = this.resolveViewTime();
    return this.findMonthlyFile(month.year, month.month);
  }

  private findMonthlyFile(year: number, month: number): TFile | null {
    const fileName = `${year}.${month}.md`;
    return this.app.vault.getMarkdownFiles().find((file) => file.name === fileName) ?? null;
  }

  private getActiveMonthlyFileMeta(): MonthlyFile | null {
    const activeFile = this.app.workspace.getActiveFile() ?? this.lastActiveMarkdownFile;
    return activeFile ? parseMonthlyFileName(activeFile.name) : null;
  }

  private syncToActiveMonth(month: MonthlyFile): void {
    const weeks = buildMonthWeeks(month);
    const ownedWeek = weeks.find((week) => isSameMonth(monthFromWeekKey(week.key), month)) ?? weeks[0];
    if (!ownedWeek) return;
    this.selectedWeekKey = ownedWeek.key;
    this.selectedDayKey = ownedWeek.days[0]?.key ?? null;
    this.timeNavScrollLeft = { week: 0, day: 0 };
    this.inputTarget = null;
    this.tagCreatePrefix = null;
    this.openProgressTaskId = null;
    this.priorUnfinishedExpanded = false;
    this.timePickerBrowseMonth = { ...month };
    void this.render();
  }

  private isViewingToday(): boolean {
    return this.selectedDayKey === formatDateKey(new Date());
  }

  private async jumpToToday(): Promise<void> {
    const todayKey = formatDateKey(new Date());
    const weekKey = computeWeekKey(todayKey);
    const ownerMonth = monthFromWeekKey(weekKey);
    const ownerWeeks = buildMonthWeeks(ownerMonth);
    const todayWeek = ownerWeeks.find((week) => week.key === weekKey);
    this.selectedWeekKey = weekKey;
    this.selectedDayKey = todayKey;
    this.timeNavScrollLeft = { week: 0, day: 0 };
    this.inputTarget = null;
    this.tagCreatePrefix = null;
    this.openProgressTaskId = null;
    this.priorUnfinishedExpanded = false;
    this.multiSelect = null;
    this.timePickerMode = "week";
    this.timePickerBrowseMonth = { ...ownerMonth };
    const shouldPreservePicker = this.weekPickerOpen && Boolean(this.weekPickerEl);
    this.preserveWeekPickerDuringRender = shouldPreservePicker;
    try {
      await this.render();
    } finally {
      this.preserveWeekPickerDuringRender = false;
    }
    if (shouldPreservePicker && todayWeek) {
      this.refreshOpenWeekPicker(ownerWeeks, weekKey);
    }
  }

  private async render(): Promise<void> {
    this.clearTaskInputOverlay();
    const renderVersion = ++this.renderVersion;
    this.rendering = true;
    try {
    const root = this.containerEl.children[1] as HTMLElement;
    this.prepareRootScrollFrame(root);
    this.removePriorDock();
    if (!this.preserveWeekPickerDuringRender) {
      this.removeWeekPickerElement();
    }
    root.empty();
    root.addClass("task-flow-view");

    const viewTime = this.resolveViewTime();
    const { month, weeks, selectedWeek, selectedDay } = viewTime;
    const targetFile = this.findMonthlyFile(month.year, month.month);
    const monthData = targetFile
      ? await this.store.ensureMonth(targetFile)
      : createEmptyMonthTaskData();

    if (renderVersion !== this.renderVersion) {
      return;
    }

    if (targetFile?.path !== this.lastTasklogFilePath) {
      this.lastTasklogSet = null;
      this.lastTasklogFilePath = targetFile?.path ?? null;
    }

    // Initialize tasklog baseline so the first modify event detects changes.
    if (targetFile && !this.lastTasklogSet) {
      const currentContent = await this.app.vault.read(targetFile);
      this.lastTasklogSet = findTasklog(currentContent);
    }

    root.empty();
    root.addClass("task-flow-view");
    const titleBar = root.createDiv({ cls: "task-flow-page-title" });
    const titleButton = titleBar.createEl("button", {
      cls: "task-flow-page-title-button",
      text: formatMonthTitle(month),
      attr: {
        "aria-label": "\u9009\u62e9\u65f6\u95f4"
      }
    });
    bindPrimaryAction(titleButton, () => {
      this.weekPickerTrigger = "time";
      this.weekPickerOpen = true;
      this.timePickerMode = "week";
      this.timePickerBrowseMonth = { ...month };
      this.showWeekPicker(
        titleButton,
        weeks,
        selectedWeek.key,
        (key) => this.selectWeek(weeks, key)
      );
    });
    const activeMonth = this.getActiveMonthlyFileMeta();
    if (activeMonth && !isSameMonth(activeMonth, month)) {
      const syncButton = titleBar.createEl("button", {
        cls: "task-flow-sync-month-button",
        text: this.isMobileLayout()
          ? "\u540c\u6b65\u672c\u6708"
          : "\u540c\u6b65\u5230\u5f53\u524d\u6708",
        attr: {
          "aria-label": "\u540c\u6b65\u5230\u5f53\u524d\u6708"
        }
      });
      bindPrimaryAction(syncButton, () => {
        this.syncToActiveMonth(activeMonth);
      });
    }
    if (!targetFile) {
      root.createDiv({
        cls: "task-flow-notice",
        text: `\u672a\u627e\u5230 ${formatMonthTitle(month)}.md\uff0c\u5f53\u524d\u4ec5\u663e\u793a\u7a7a\u4efb\u52a1\u9762\u677f\u3002`
      });
    }
    this.renderSectionSwitcher(
      root,
      weeks,
      selectedWeek,
      formatDayTitleLabel(selectedDay.date)
    );
    this.renderUnifiedActionRow(root, weeks, monthData, selectedWeek, selectedDay);
    this.renderSectionLayers(root, weeks, monthData, selectedWeek, selectedDay);
    this.renderMobileActionBar(root, weeks, selectedWeek, selectedDay);
    this.scheduleMobileBottomFadePosition();
    this.setupMobileSectionSwipe(root, weeks);
    this.setupMobileScrollIsolation(root);
    if (this.weekPickerOpen && !this.weekPickerEl) {
      this.restoreWeekPicker(weeks);
    }
    } finally {
      this.rendering = false;
    }
  }

  private renderSectionSwitcher(
    root: Element,
    weeks: CalendarWeek[],
    selectedWeek: CalendarWeek,
    dayLabel: string
  ): void {
    const switcher = root.createDiv({
      cls: `task-flow-section-switcher is-${this.activeSection}`,
      attr: {
        role: "tablist",
        "aria-label": "切换周任务和日任务"
      }
    });
    const slider = switcher.createDiv({ cls: "task-flow-section-switch-slider" });
    slider.createSpan({ cls: "task-flow-slider-label is-week-label", text: "周任务" });
    const daySliderLabel = slider.createSpan({ cls: "task-flow-slider-label is-day-label" });
    const dayWeekPickerIcon = daySliderLabel.createSpan({
      cls: "task-flow-day-week-picker-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(dayWeekPickerIcon, "calendar-range");
    daySliderLabel.createSpan({ text: "日任务" });
    const weekButton = switcher.createEl("button", {
      cls: `task-flow-section-switch-option${this.activeSection === "week" ? " is-active" : ""}`,
      attr: {
        role: "tab",
        "aria-selected": this.activeSection === "week" ? "true" : "false"
      }
    });
    weekButton.createSpan({ cls: "task-flow-switch-context-label", text: selectedWeek.label });
    const dayButton = switcher.createEl("button", {
      cls: `task-flow-section-switch-option${this.activeSection === "day" ? " is-active" : ""}`,
      attr: {
        role: "tab",
        "aria-selected": this.activeSection === "day" ? "true" : "false"
      }
    });
    dayButton.createSpan({ cls: "task-flow-switch-context-label", text: dayLabel });
    bindPrimaryAction(weekButton, () => this.switchSection("week"));
    bindPrimaryAction(dayButton, () => {
      if (this.activeSection !== "day") {
        this.switchSection("day");
        return;
      }
      this.weekPickerTrigger = "day-switch";
      this.weekPickerOpen = true;
      this.showWeekPicker(
        dayButton,
        weeks,
        selectedWeek.key,
        (key) => this.selectWeek(weeks, key)
      );
    });
  }

  private renderUnifiedActionRow(
    root: Element,
    weeks: CalendarWeek[],
    monthData: MonthTaskData,
    selectedWeek: CalendarWeek,
    selectedDay: CalendarWeek["days"][number]
  ): void {
    const row = root.createDiv({
      cls: `task-flow-unified-action-row is-${this.activeSection}`
    });
    const timeButton = row.createEl("button", {
      cls: "task-flow-unified-time-pill",
      attr: {
        "aria-label": this.activeSection === "week" ? "选择周" : "当前日期",
        "aria-expanded": this.activeSection === "week" && this.weekPickerOpen ? "true" : "false"
      }
    });
    const weekContent = timeButton.createSpan({ cls: "task-flow-unified-time-content is-week-content" });
    weekContent.createSpan({ text: selectedWeek.label });
    const weekIcon = weekContent.createSpan({ cls: "task-flow-week-pill-icon" });
    setIcon(weekIcon, this.weekPickerOpen ? "chevron-up" : "chevron-down");
    timeButton.createSpan({
      cls: "task-flow-unified-time-content is-day-content",
      text: formatDayTitleLabel(selectedDay.date)
    });
    if (!this.isMobileLayout()) {
      bindPrimaryAction(timeButton, () => {
        if (this.activeSection !== "week") {
          return;
        }
        this.weekPickerTrigger = "time";
        this.weekPickerOpen = !this.weekPickerOpen;
        timeButton.setAttribute("aria-expanded", this.weekPickerOpen ? "true" : "false");
        setIcon(weekIcon, this.weekPickerOpen ? "chevron-up" : "chevron-down");
        if (!this.weekPickerOpen) {
          this.closeWeekPicker();
          return;
        }
        this.showWeekPicker(
          timeButton,
          weeks,
          selectedWeek.key,
          (key) => this.selectWeek(weeks, key)
        );
      });
    }

    if (!this.isMobileLayout() && this.activeSection === "day" && !this.isViewingToday()) {
      const todayButton = row.createEl("button", {
        cls: "task-flow-today-button",
        text: "\u4eca",
        attr: { "aria-label": "\u56de\u5230\u4eca\u5929" }
      });
      bindPrimaryAction(todayButton, () => {
        void this.jumpToToday();
      });
    }

    const addButton = row.createEl("button", {
      cls: "task-flow-add-button task-flow-unified-add-button",
      attr: { "aria-label": this.activeSection === "week" ? "添加周任务" : "添加日任务" }
    });
    setIcon(addButton, "plus");
    bindPrimaryAction(addButton, () => this.beginCreateForActiveSection());

    if (this.multiSelect?.sectionId === this.activeSection) {
      const selectableKeys = this.getVisibleSelectionKeys(
        monthData,
        selectedWeek,
        selectedDay
      );
      const allSelected = selectableKeys.length > 0
        && selectableKeys.every((key) => this.multiSelect!.selectedKeys.has(key));
      const toolbar = row.createDiv({ cls: "task-flow-multi-toolbar" });
      toolbar.createSpan({
        cls: "task-flow-multi-toolbar-count",
        text: `已选择 ${this.multiSelect.selectedKeys.size} 项`
      });
      const selectAll = toolbar.createEl("button", {
        cls: "task-flow-multi-toolbar-button",
        text: allSelected ? "取消全选" : "全选"
      });
      bindPrimaryAction(selectAll, () => {
        if (!this.multiSelect) return;
        if (allSelected) {
          for (const key of selectableKeys) {
            this.multiSelect.selectedKeys.delete(key);
          }
        } else {
          for (const key of selectableKeys) {
            this.multiSelect.selectedKeys.add(key);
          }
        }
        void this.renderPreservingTaskScroll(this.activeSection);
      });
      const exit = toolbar.createEl("button", {
        cls: "task-flow-multi-toolbar-button",
        text: "退出"
      });
      bindPrimaryAction(exit, () => {
        this.multiSelect = null;
        void this.renderPreservingTaskScroll(this.activeSection);
      });
    }
  }

  private getVisibleSelectionKeys(
    monthData: MonthTaskData,
    selectedWeek: CalendarWeek,
    selectedDay: CalendarWeek["days"][number]
  ): string[] {
    const tasks = this.activeSection === "week"
      ? buildWeekTaskTree(
        monthData,
        getWeekTaskIds(monthData, selectedWeek.key),
        this.weekTaskFilter
      )
      : groupSourceContexts(
        buildTaskTree(monthData, getDayTaskIds(monthData, selectedDay.key))
      );
    const keys = new Set<string>();
    const collect = (items: DemoTask[]): void => {
      for (const task of items) {
        const key = task.actionTaskId ?? task.id;
        if (
          !task.isSourceGroup
          && !task.isDateGroup
          && !key.startsWith("parent-context:")
          && !key.startsWith("source-group:")
          && !key.startsWith("date-group:")
        ) {
          keys.add(key);
        }
        collect(task.children ?? []);
      }
    };
    collect(tasks);
    return [...keys];
  }

  private renderMobileActionBar(
    root: Element,
    weeks: CalendarWeek[],
    selectedWeek: CalendarWeek,
    selectedDay: CalendarWeek["days"][number]
  ): void {
    if (!this.isMobileLayout()) {
      return;
    }
    const rootElement = root as HTMLElement;

    const priorCount = this.priorUnfinishedSnapshot?.sections
      .reduce((sum, section) => sum + section.tasks.length, 0) ?? 0;
    root.createDiv({ cls: "task-flow-mobile-bottom-fade" });
    const bar = root.createDiv({
      cls: `task-flow-mobile-actions is-${this.activeSection}`
    });
    bar.dataset.weekLabel = selectedWeek.label;
    bar.dataset.dayLabel = `本周${formatDayKey(selectedDay.key)}前未完成（${priorCount}）`;
    bar.dataset.priorCount = String(priorCount);
    const timeButton = bar.createEl("button", {
      cls: "task-flow-mobile-time-button",
      attr: {
        "aria-label": this.activeSection === "week"
          ? "选择周"
          : `本周${formatDayKey(selectedDay.key)}前未完成，共 ${priorCount} 项`
      }
    });
    const timeIcon = timeButton.createSpan({ cls: "task-flow-mobile-time-icon" });
    setIcon(timeIcon, this.activeSection === "week" ? "calendar-range" : "history");
    timeButton.createSpan({
      cls: "task-flow-mobile-time-label",
      text: this.activeSection === "week"
        ? selectedWeek.label
        : `本周${formatDayKey(selectedDay.key)}前未完成（${priorCount}）`
    });
    const chevron = timeButton.createSpan({ cls: "task-flow-mobile-time-chevron" });
    setIcon(
      chevron,
      this.activeSection === "day" && this.priorUnfinishedExpanded
        ? "chevron-down"
        : "chevron-up"
    );

    bindMobileTap(timeButton, () => {
      if (this.activeSection === "week") {
        this.weekPickerTrigger = "time";
        this.weekPickerOpen = true;
        this.showWeekPicker(
          timeButton,
          weeks,
          selectedWeek.key,
          (key) => this.selectWeek(weeks, key)
        );
        return;
      }

      if (priorCount === 0) {
        return;
      }
      this.priorUnfinishedExpanded = !this.priorUnfinishedExpanded;
      this.openProgressTaskId = null;
      void this.render();
    });

    if (this.activeSection === "day" && priorCount === 0) {
      timeButton.addClass("is-disabled");
      timeButton.setAttribute("aria-disabled", "true");
    }

    if (
      this.activeSection === "day"
      && this.priorUnfinishedExpanded
      && this.priorUnfinishedSnapshot
      && priorCount > 0
    ) {
      const priorPanel = this.renderMobilePriorPanel(root, this.priorUnfinishedSnapshot.sections);
      bar.before(priorPanel);
      const updatePriorPanelHeight = (): void => {
        if (!priorPanel.isConnected) {
          return;
        }
        rootElement.style.setProperty(
          "--tf-prior-dock-height",
          `${Math.ceil(priorPanel.getBoundingClientRect().height + 8)}px`
        );
      };
      window.requestAnimationFrame(() => {
        updatePriorPanelHeight();
        window.requestAnimationFrame(updatePriorPanelHeight);
      });
      window.setTimeout(updatePriorPanelHeight, 300);
    } else {
      rootElement.style.setProperty("--tf-prior-dock-height", "0px");
    }

    const addStack = bar.createDiv({ cls: "task-flow-mobile-add-stack" });
    const addButton = addStack.createEl("button", {
      cls: "task-flow-mobile-add-button",
      attr: {
        "aria-label": this.activeSection === "week" ? "添加周任务" : "添加日任务"
      }
    });
    setIcon(addButton, "plus");
    bindMobileTap(addButton, () => this.beginCreateForActiveSection());

    if (this.activeSection === "day" && !this.isViewingToday()) {
      const todayButton = addStack.createEl("button", {
        cls: "task-flow-mobile-today-button",
        text: "\u4eca",
        attr: { "aria-label": "\u56de\u5230\u4eca\u5929" }
      });
      bindMobileTap(todayButton, () => this.jumpToToday());
    }

    const switchButton = bar.createEl("button", {
      cls: "task-flow-mobile-section-button",
      attr: {
        "aria-label": this.activeSection === "week" ? "切换到日任务" : "切换到周任务"
      }
    });
    switchButton.createSpan({
      cls: "task-flow-mobile-section-label",
      text: this.activeSection === "week" ? "日" : "周"
    });
    bindMobileTap(switchButton, () => {
      this.switchSection(this.activeSection === "week" ? "day" : "week");
    });
  }

  private scheduleMobileBottomFadePosition(): void {
    if (!this.isMobileLayout()) {
      return;
    }
    window.requestAnimationFrame(() => {
      this.positionMobileBottomFade();
      window.requestAnimationFrame(() => this.positionMobileBottomFade());
    });
    window.setTimeout(() => this.positionMobileBottomFade(), 300);
  }

  private positionMobileBottomFade(): void {
    if (!this.isMobileLayout()) {
      return;
    }
    const root = this.containerEl.children[1] as HTMLElement | undefined;
    const fade = root?.querySelector<HTMLElement>(".task-flow-mobile-bottom-fade");
    const actions = root?.querySelector<HTMLElement>(".task-flow-mobile-actions");
    const scroller = root?.querySelector<HTMLElement>(
      this.activeSection === "day"
        ? ".is-day-layer .task-flow-day-task-list"
        : ".is-week-layer .task-flow-panel-body"
    );
    if (!root || !fade || !actions || !scroller) {
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const top = actionsRect.top - rootRect.top;
    const height = Math.max(0, scrollerRect.bottom - actionsRect.top);
    fade.style.top = `${Math.round(top)}px`;
    fade.style.height = `${Math.round(height)}px`;
  }

  private renderMobilePriorPanel(
    root: Element,
    sections: PriorUnfinishedSection[]
  ): HTMLElement {
    const panel = root.createDiv({ cls: "task-flow-mobile-prior-panel" });
    const scroller = panel.createDiv({ cls: "task-flow-mobile-prior-scroller" });
    for (const section of sections) {
      const group = scroller.createDiv({ cls: "task-flow-prior-group" });
      group.createDiv({ cls: "task-flow-prior-group-title", text: section.title });
      for (const task of section.tasks) {
        this.renderTaskCard(group, task, "day");
      }
    }
    return panel;
  }

  private renderSectionLayers(
    root: Element,
    weeks: CalendarWeek[],
    monthData: MonthTaskData,
    selectedWeek: CalendarWeek,
    selectedDay: CalendarWeek["days"][number]
  ): void {
    const content = root.createDiv({
      cls: `task-flow-section-content is-${this.activeSection}`
    });
    const weekLayer = content.createDiv({
      cls: `task-flow-section-layer is-week-layer${this.activeSection === "week" ? " is-active" : ""}`,
      attr: { "aria-hidden": this.activeSection === "week" ? "false" : "true" }
    });
    const dayLayer = content.createDiv({
      cls: `task-flow-section-layer is-day-layer${this.activeSection === "day" ? " is-active" : ""}`,
      attr: { "aria-hidden": this.activeSection === "day" ? "false" : "true" }
    });

    const weekTasks = buildWeekTaskTree(
      monthData,
      getWeekTaskIds(monthData, selectedWeek.key),
      this.weekTaskFilter
    );
    this.renderTaskSection(weekLayer, {
      id: "week",
      title: "周任务",
      collapsedSummary: selectedWeek.label,
      hideHeader: true,
      options: weeks.map((week) => ({ key: week.key, label: week.label })),
      selectedKey: selectedWeek.key,
      tasks: weekTasks,
      createArea: "week",
      createAreaKey: selectedWeek.key,
      onSelect: (key) => this.selectWeek(weeks, key)
    });

    const dayTasks = groupSourceContexts(
      buildTaskTree(monthData, getDayTaskIds(monthData, selectedDay.key))
    );
    const priorUnfinishedSections = buildPriorUnfinishedSections(
      monthData,
      selectedWeek,
      selectedDay.key
    );
    this.renderTaskSection(dayLayer, {
      id: "day",
      title: "日任务",
      collapsedSummary: selectedDay.shortLabel,
      hideHeader: true,
      options: selectedWeek.days.map((day) => ({
        key: day.key,
        label: day.shortLabel,
        hasTasks: flattenOrderArray(getDayTaskIds(monthData, day.key))
          .some((taskId) => Boolean(monthData.tasks[taskId]))
      })),
      selectedKey: selectedDay.key,
      tasks: dayTasks,
      createArea: "day",
      createAreaKey: selectedDay.key,
      onSelect: (key) => {
        this.selectedDayKey = key;
        this.inputTarget = null;
        this.openProgressTaskId = null;
        this.priorUnfinishedExpanded = false;
        void this.render();
      }
    });
    this.priorUnfinishedSnapshot = {
      label: `本周${formatDayKey(selectedDay.key)}前未完成任务`,
      sections: priorUnfinishedSections
    };
    if (this.activeSection === "day" && !this.isMobileLayout()) {
      this.renderPriorUnfinished(
        dayLayer,
        this.priorUnfinishedSnapshot.label,
        this.priorUnfinishedSnapshot.sections
      );
    }
  }

  private async selectWeek(weeks: CalendarWeek[], key: string): Promise<void> {
    const ownerMonth = monthFromWeekKey(key);
    const ownerWeeks = buildMonthWeeks(ownerMonth);
    const nextWeek = ownerWeeks.find((week) => week.key === key)
      ?? weeks.find((week) => week.key === key);
    if (!nextWeek) {
      return;
    }
    this.selectedWeekKey = key;
    this.selectedDayKey = nextWeek.days[0]?.key ?? null;
    this.timeNavScrollLeft.day = 0;
    this.inputTarget = null;
    this.openProgressTaskId = null;
    this.priorUnfinishedExpanded = false;
    this.timePickerBrowseMonth = { ...ownerMonth };
    const shouldPreservePicker = this.weekPickerOpen && Boolean(this.weekPickerEl);
    this.preserveWeekPickerDuringRender = shouldPreservePicker;
    try {
      await this.render();
    } finally {
      this.preserveWeekPickerDuringRender = false;
    }
    if (shouldPreservePicker) {
      this.refreshOpenWeekPicker(ownerWeeks, key);
    }
  }

  private async beginCreateForActiveSection(): Promise<void> {
    const area = this.activeSection;
    const areaKey = area === "week" ? this.selectedWeekKey : this.selectedDayKey;
    if (!areaKey || !await this.canCreateInArea(area, areaKey)) {
      this.inputTarget = null;
      return;
    }
    if (this.isMobileLayout()) {
      this.inputTarget = `create-${area}`;
      let modal: MobileTaskCreateModal;
      const clearModal = (): void => {
        if (this.taskInputOverlayCleanup === closeModal) {
          this.taskInputOverlayCleanup = null;
        }
        if (this.inputTarget === `create-${area}`) {
          this.inputTarget = null;
        }
      };
      const closeModal = (): void => {
        modal.close();
      };
      modal = new MobileTaskCreateModal(
        this.app,
        async (name) => {
          const file = this.requireTargetMonthlyFile();
          if (!file) {
            throw new Error("未找到当前月文档");
          }
          this.suppressStoreRender += 1;
          try {
            await createTopLevelTask(
              this.store,
              this.app.vault,
              file,
              area,
              areaKey,
              name
            );
            this.inputTarget = null;
            this.pendingStoreRender = false;
            await this.render();
          } finally {
            this.suppressStoreRender = Math.max(0, this.suppressStoreRender - 1);
            if (this.suppressStoreRender === 0 && this.pendingStoreRender) {
              this.pendingStoreRender = false;
              void this.render();
            }
          }
        },
        clearModal
      );
      this.taskInputOverlayCleanup = closeModal;
      modal.open();
      return;
    }
    this.inputTarget = `create-${area}`;
    await this.render();
  }

  private async beginEditTask(task: DemoTask, key: string): Promise<void> {
    if (!this.requireTargetMonthlyFile()) {
      return;
    }
    const editTaskId = task.actionTaskId ?? task.id;
    this.inputTarget = `edit-${key}`;
    this.openProgressTaskId = null;
    this.closeCustomMenu();

    if (this.isMobileLayout()) {
      let modal: MobileTaskCreateModal;
      const clearModal = (): void => {
        if (this.taskInputOverlayCleanup === closeModal) {
          this.taskInputOverlayCleanup = null;
        }
        if (this.inputTarget === `edit-${key}`) {
          this.inputTarget = null;
        }
      };
      const closeModal = (): void => {
        modal.close();
      };
      modal = new MobileTaskCreateModal(
        this.app,
        async (name) => {
          const latestFile = this.requireTargetMonthlyFile();
          if (!latestFile) {
            throw new Error("未找到当前月文档");
          }
          this.suppressStoreRender += 1;
          try {
            await renameTask(this.store, this.app.vault, latestFile, editTaskId, name);
            this.inputTarget = null;
            this.pendingStoreRender = false;
            await this.render();
          } finally {
            this.suppressStoreRender = Math.max(0, this.suppressStoreRender - 1);
            if (this.suppressStoreRender === 0 && this.pendingStoreRender) {
              this.pendingStoreRender = false;
              void this.render();
            }
          }
        },
        clearModal,
        {
          initialValue: task.editName ?? task.name,
          placeholder: "编辑任务名称",
          failureMessage: "编辑任务失败"
        }
      );
      this.taskInputOverlayCleanup = closeModal;
      modal.open();
      return;
    }

    await this.render();
  }

  private switchSection(nextSection: SectionKind): void {
    if (nextSection === this.activeSection || this.switchingSection) {
      return;
    }

    this.switchingSection = true;
    this.inputTarget = null;
    this.openProgressTaskId = null;
    this.multiSelect = null;
    this.weekPickerOpen = false;
    this.closeWeekPicker();
    this.closeCustomMenu();

    const root = this.containerEl.children[1] as HTMLElement | undefined;
    const mobileLayout = this.isMobileLayout();
    if (mobileLayout) {
      this.priorUnfinishedExpanded = false;
      root?.querySelector<HTMLElement>(".task-flow-mobile-prior-panel")?.remove();
    }
    const switcher = root?.querySelector<HTMLElement>(".task-flow-section-switcher");
    const actionRow = root?.querySelector<HTMLElement>(".task-flow-unified-action-row");
    const mobileActions = root?.querySelector<HTMLElement>(".task-flow-mobile-actions");
    const content = root?.querySelector<HTMLElement>(".task-flow-section-content");
    const weekLayer = content?.querySelector<HTMLElement>(".is-week-layer");
    const dayLayer = content?.querySelector<HTMLElement>(".is-day-layer");
    const currentLayer = this.activeSection === "week" ? weekLayer : dayLayer;
    const nextLayer = nextSection === "week" ? weekLayer : dayLayer;
    switcher?.classList.remove(`is-${this.activeSection}`);
    switcher?.classList.add(`is-${nextSection}`);
    actionRow?.classList.remove(`is-${this.activeSection}`);
    actionRow?.classList.add(`is-${nextSection}`);
    mobileActions?.classList.remove(`is-${this.activeSection}`);
    mobileActions?.classList.add(`is-${nextSection}`);
    content?.classList.remove(`is-${this.activeSection}`);
    content?.classList.add(`is-${nextSection}`, "is-transitioning");
    switcher?.querySelectorAll<HTMLElement>(".task-flow-section-switch-option")
      .forEach((button, index) => {
        const active = (nextSection === "week" && index === 0) || (nextSection === "day" && index === 1);
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
      });
    const timeButton = actionRow?.querySelector<HTMLElement>(".task-flow-unified-time-pill");
    const addButton = actionRow?.querySelector<HTMLElement>(".task-flow-unified-add-button");
    timeButton?.setAttribute("aria-label", nextSection === "week" ? "选择周" : "当前日期");
    timeButton?.setAttribute("aria-expanded", "false");
    addButton?.setAttribute("aria-label", nextSection === "week" ? "添加周任务" : "添加日任务");
    const mobileTimeButton = mobileActions?.querySelector<HTMLElement>(".task-flow-mobile-time-button");
    const mobileTimeIcon = mobileActions?.querySelector<HTMLElement>(".task-flow-mobile-time-icon");
    const mobileTimeLabel = mobileActions?.querySelector<HTMLElement>(".task-flow-mobile-time-label");
    const mobileTimeChevron = mobileActions?.querySelector<HTMLElement>(".task-flow-mobile-time-chevron");
    const mobileAddButton = mobileActions?.querySelector<HTMLElement>(".task-flow-mobile-add-button");
    const mobileSwitchButton = mobileActions?.querySelector<HTMLElement>(".task-flow-mobile-section-button");
    const mobileSwitchLabel = mobileActions?.querySelector<HTMLElement>(".task-flow-mobile-section-label");
    const mobilePriorCount = Number(mobileActions?.dataset.priorCount ?? "0");
    mobileTimeButton?.setAttribute(
      "aria-label",
      nextSection === "week"
        ? "选择周"
        : `${mobileActions?.dataset.dayLabel ?? "本周当前日期前未完成"}，共 ${mobilePriorCount} 项`
    );
    mobileTimeButton?.classList.toggle(
      "is-disabled",
      nextSection === "day" && mobilePriorCount === 0
    );
    if (nextSection === "day" && mobilePriorCount === 0) {
      mobileTimeButton?.setAttribute("aria-disabled", "true");
    } else {
      mobileTimeButton?.removeAttribute("aria-disabled");
    }
    mobileAddButton?.setAttribute("aria-label", nextSection === "week" ? "添加周任务" : "添加日任务");
    mobileSwitchButton?.setAttribute("aria-label", nextSection === "week" ? "切换到日任务" : "切换到周任务");
    mobileSwitchLabel?.setText(nextSection === "week" ? "日" : "周");
    if (mobileTimeIcon) {
      setIcon(mobileTimeIcon, nextSection === "week" ? "calendar-range" : "history");
    }
    if (mobileTimeLabel && mobileActions) {
      mobileTimeLabel.setText(
        nextSection === "week"
          ? mobileActions.dataset.weekLabel ?? ""
          : mobileActions.dataset.dayLabel ?? ""
      );
    }
    if (mobileTimeChevron) {
      setIcon(mobileTimeChevron, "chevron-up");
    }
    this.scheduleMobileBottomFadePosition();
    currentLayer?.classList.remove("is-active", "is-entering");
    currentLayer?.classList.add("is-leaving");
    currentLayer?.setAttribute("aria-hidden", "true");
    nextLayer?.classList.remove("is-leaving");
    nextLayer?.classList.add("is-active", "is-entering");
    nextLayer?.setAttribute("aria-hidden", "false");
    this.activeSection = nextSection;
    if (nextSection === "week") {
      this.removePriorDock();
    }

    this.sectionSwitchTimer = setTimeout(() => {
      this.sectionSwitchTimer = null;
      content?.classList.remove("is-transitioning");
      currentLayer?.classList.remove("is-leaving");
      nextLayer?.classList.remove("is-entering");
      this.switchingSection = false;
      if (nextSection === "day" && this.priorUnfinishedSnapshot && !mobileLayout) {
        this.renderPriorUnfinished(
          nextLayer ?? content ?? root!,
          this.priorUnfinishedSnapshot.label,
          this.priorUnfinishedSnapshot.sections
        );
      }
    }, 280);
  }

  private prepareRootScrollFrame(root: HTMLElement): void {
    root.addClass("task-flow-view");
    root.style.overflowY = "hidden";
    root.style.overflowX = "hidden";
    root.style.height = "100%";
    root.style.maxHeight = "100%";
    root.style.minHeight = "0";
    root.style.boxSizing = "border-box";
  }

  private clearTaskInputOverlay(): void {
    const cleanup = this.taskInputOverlayCleanup;
    this.taskInputOverlayCleanup = null;
    cleanup?.();
  }

  private renderTaskSection(
    root: Element,
    config: {
      id: SectionKind;
      title: string;
      collapsedSummary: string;
      options?: Array<{ key: string; label: string; hasTasks?: boolean }>;
      selectedKey?: string;
      tasks: DemoTask[];
      onSelect?: (key: string) => void;
      allowAdd?: boolean;
      createArea?: TaskArea;
      createAreaKey?: string;
      weekPickerWeeks?: CalendarWeek[];
      dayLabel?: string;
      hideHeader?: boolean;
    }
  ): void {
    const section = root.createDiv({
      cls: `task-flow-panel${config.id === "day" ? " is-day-panel" : ""}${config.hideHeader ? " has-hidden-header" : ""}`
    });
    const header = config.hideHeader ? null : section.createDiv({ cls: "task-flow-panel-header" });
    const titleGroup = header?.createDiv({ cls: "task-flow-panel-title-group" }) ?? null;
    if (titleGroup) {
      const toggle = titleGroup.createEl("button", {
        cls: "task-flow-collapse-button",
        attr: { "aria-label": `折叠${config.title}` }
      });
      setIcon(toggle, this.collapsedSections.has(config.id) ? "chevron-right" : "chevron-down");
      bindPrimaryAction(toggle, () => this.toggleSection(config.id));
      titleGroup.createDiv({ cls: "task-flow-panel-title", text: config.title });
    }
    if (titleGroup && config.id === "day" && config.dayLabel) {
      titleGroup.createDiv({
        cls: "task-flow-day-pill",
        text: config.dayLabel
      });
    }
    if (
      config.id === "week"
      && config.options
      && config.selectedKey
      && config.onSelect
      && config.weekPickerWeeks
      && titleGroup
    ) {
      const selectedOption = config.options.find((option) => option.key === config.selectedKey);
      const weekButton = titleGroup.createEl("button", {
        cls: `task-flow-week-pill${this.weekPickerOpen ? " is-open" : ""}`,
        attr: {
          "aria-expanded": this.weekPickerOpen ? "true" : "false",
          "aria-label": "选择周",
        },
      });
      weekButton.createSpan({ text: selectedOption?.label ?? config.selectedKey });
      const weekButtonIcon = weekButton.createSpan({ cls: "task-flow-week-pill-icon" });
      setIcon(weekButtonIcon, this.weekPickerOpen ? "chevron-up" : "chevron-down");
      bindPrimaryAction(weekButton, () => {
        this.weekPickerOpen = !this.weekPickerOpen;
        void this.render();
      });
      if (this.weekPickerOpen) {
        window.requestAnimationFrame(() => {
          if (!weekButton.isConnected || !this.weekPickerOpen) return;
          this.showWeekPicker(
            weekButton,
            config.weekPickerWeeks!,
            config.selectedKey!,
            config.onSelect!,
          );
        });
      }
    }
    if (titleGroup && this.collapsedSections.has(config.id) && config.id !== "week") {
      titleGroup.createDiv({
        cls: "task-flow-panel-summary",
        text: config.collapsedSummary
      });
    }

    if (header && this.multiSelect?.sectionId === config.id) {
      header.createDiv({
        cls: "task-flow-multi-count",
        text: `已选择 ${this.multiSelect.selectedKeys.size} 项`
      });
      const exitButton = header.createEl("button", {
        cls: "task-flow-text-button",
        text: "退出多选"
      });
      bindPrimaryAction(exitButton, () => {
        this.multiSelect = null;
        void this.renderPreservingTaskScroll(config.id);
      });
    }

    if (header && config.allowAdd !== false) {
      const addButton = header.createEl("button", {
        cls: "task-flow-add-button",
        attr: { "aria-label": `添加${config.title}` }
      });
      setIcon(addButton, "plus");
      bindPrimaryAction(addButton, async () => {
        if (this.isMobileLayout()) {
          if (config.id !== this.activeSection) {
            this.activeSection = config.id;
          }
          await this.beginCreateForActiveSection();
          return;
        }
        if (
          config.createArea
          && config.createAreaKey
          && !await this.canCreateInArea(config.createArea, config.createAreaKey)
        ) {
          this.inputTarget = null;
          return;
        }
        this.inputTarget = `create-${config.id}`;
        await this.render();
      });
    }

    if (this.collapsedSections.has(config.id)) {
      return;
    }

    if (config.id === "day" && config.options && config.selectedKey && config.onSelect) {
      const selectorShell = section.createDiv({ cls: "task-flow-time-nav" });
      const leftEdge = selectorShell.createEl("button", {
        cls: "task-flow-time-edge is-left",
        attr: {
          "aria-label": "向前查看更多日期",
          type: "button"
        }
      });
      setIcon(leftEdge, "chevron-left");
      const selector = selectorShell.createDiv({
        cls: "task-flow-inline-selector",
        attr: {
          role: "tablist",
          "aria-label": "选择日期"
        }
      });
      const rightEdge = selectorShell.createEl("button", {
        cls: "task-flow-time-edge is-right",
        attr: {
          "aria-label": "向后查看更多日期",
          type: "button"
        }
      });
      setIcon(rightEdge, "chevron-right");
      let activeButton: HTMLButtonElement | null = null;
      const selectDay = new Map<HTMLButtonElement, () => void>();
      for (const option of config.options) {
        const button = selector.createEl("button", {
          cls: `task-flow-inline-option${option.key === config.selectedKey ? " is-active" : ""}`,
          attr: {
            role: "tab",
            "aria-selected": option.key === config.selectedKey ? "true" : "false",
            draggable: "false"
          }
        });
        button.createSpan({ cls: "task-flow-inline-option-label", text: option.label });
        if (option.hasTasks) {
          button.createSpan({
            cls: "task-flow-inline-option-dot",
            attr: { "aria-label": "该日期有任务" }
          });
        }
        if (option.key === config.selectedKey) {
          activeButton = button;
        }
        selectDay.set(button, () => config.onSelect?.(option.key));
      }
      this.setupTimeNavigation(config.id, selectorShell, selector, activeButton, selectDay);
    }

    if (config.id === "week") {
      this.renderWeekFilter(section);
    }

    const body = section.createDiv({
      cls: `task-flow-panel-body${config.id === "day" ? " task-flow-day-viewport" : ""}`
    });
    const taskContainer = config.id === "day"
      ? body.createDiv({ cls: "task-flow-day-task-list" })
      : body;
    if (config.tasks.length === 0) {
      if (this.inputTarget !== `create-${config.id}`) {
        this.renderSectionEmptyState(taskContainer, config.id);
      }
    }

    this.renderTaskList(taskContainer, config.tasks, config.id);

    if (
      this.inputTarget === `create-${config.id}`
      && config.createArea
      && config.createAreaKey
    ) {
      const createRow = taskContainer.createDiv({ cls: "task-flow-create-row" });
      this.renderTaskInput(createRow, this.tagCreatePrefix ?? "", async (name) => {
        const file = this.requireTargetMonthlyFile();
        if (!file) {
          return;
        }
        await createTopLevelTask(
          this.store,
          this.app.vault,
          file,
          config.createArea!,
          config.createAreaKey!,
          name
        );
        this.tagCreatePrefix = null;
      });
    }

    if (config.id === "day") {
      this.lockLocalScroll(taskContainer);
    }
  }

  private renderTaskList(
    parent: Element,
    tasks: DemoTask[],
    sectionId: SectionKind
  ): void {
    const groups = buildTagGroups(tasks);

    if (groups.untagged.length > 0) {
      const scope = parent.createDiv({ cls: "task-flow-tag-task-scope" });
      for (const task of groups.untagged) {
        this.renderTaskCard(scope, task, sectionId);
      }
    }

    for (const group of groups.primaryGroups) {
      this.renderTagHeader(parent, group.primary, {
        sectionId,
        level: "primary",
        primary: group.primary
      });
      if (group.plainTasks.length > 0) {
        const scope = parent.createDiv({ cls: "task-flow-tag-task-scope" });
        for (const task of group.plainTasks) {
          this.renderTaskCard(scope, task, sectionId);
        }
      }
      for (const subgroup of group.subgroups) {
        const subgroupEl = parent.createDiv({ cls: "task-flow-tag-subgroup" });
        this.renderTagHeader(subgroupEl, subgroup.secondary, {
          sectionId,
          level: "secondary",
          primary: group.primary,
          secondary: subgroup.secondary
        });
        const subgroupTasksEl = subgroupEl.createDiv({ cls: "task-flow-tag-subgroup-tasks task-flow-tag-task-scope" });
        for (const task of subgroup.tasks) {
          this.renderTaskCard(subgroupTasksEl, task, sectionId);
        }
      }
    }
  }

  private renderTagHeader(parent: Element, tagName: string, context: TagMenuContext): void {
    const header = parent.createDiv({
      cls: `task-flow-tag-header is-${context.level}`
    });
    if (context.level === "secondary") {
      header.createSpan({ cls: "task-flow-tag-node-dot" });
    }
    const pill = header.createSpan({
      cls: "task-flow-tag-pill",
      text: tagName
    });
    this.bindTagPillMenu(pill, context);
  }

  private bindTagPillMenu(pill: HTMLElement, context: TagMenuContext): void {
    pill.addClass("is-interactive");
    pill.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.isMobileLayout()) {
        return;
      }
      this.openTagMenu(event, context);
    });

    pill.addEventListener("pointerdown", (event) => {
      if (!this.isMobileLayout() || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let opened = false;
      const clear = (): void => {
        window.clearTimeout(timer);
      };
      const cleanup = (): void => {
        clear();
        pill.removeEventListener("pointermove", move);
        pill.removeEventListener("pointerup", finish);
        pill.removeEventListener("pointercancel", cancel);
      };
      const timer = window.setTimeout(() => {
        opened = true;
        this.triggerLightHaptic();
        const menuEvent = new MouseEvent("contextmenu", {
          bubbles: false,
          cancelable: true,
          clientX: startX,
          clientY: startY
        });
        this.openTagMenu(menuEvent, context);
      }, 450);
      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 10) {
          cleanup();
        }
      };
      const finish = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId !== pointerId) return;
        cleanup();
        if (opened) {
          upEvent.preventDefault();
          upEvent.stopPropagation();
        }
      };
      const cancel = (cancelEvent: PointerEvent): void => {
        if (cancelEvent.pointerId !== pointerId) return;
        cleanup();
      };
      pill.addEventListener("pointermove", move);
      pill.addEventListener("pointerup", finish);
      pill.addEventListener("pointercancel", cancel);
    });
  }

  private triggerLightHaptic(): void {
    const haptics = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            Haptics?: {
              impact?: (options?: { style?: "LIGHT" | "MEDIUM" | "HEAVY" }) => Promise<void> | void;
              selectionChanged?: () => Promise<void> | void;
              vibrate?: (options?: { duration?: number }) => Promise<void> | void;
            };
          };
        };
      }
    ).Capacitor?.Plugins?.Haptics;
    try {
      const result = haptics?.impact?.({ style: "MEDIUM" })
        ?? haptics?.vibrate?.({ duration: 40 })
        ?? haptics?.selectionChanged?.();
      void Promise.resolve(result).catch(() => navigator.vibrate?.(40));
      navigator.vibrate?.(40);
    } catch {
      navigator.vibrate?.(40);
    }
  }

  private openTagMenu(event: MouseEvent, context: TagMenuContext): void {
    const items: ContextMenuItem[] = [{
      label: "新增标签任务",
      icon: "plus",
      onClick: () => { void this.beginCreateTaggedTask(context); }
    }, {
      label: "编辑标签",
      icon: "pencil",
      onClick: () => { this.openEditTagModal(context); }
    }, {
      label: "排序",
      icon: "list-ordered",
      onClick: () => { void this.openTagSortModal(context.sectionId); }
    }];
    this.showCustomMenu(event.clientX, event.clientY, items);
  }

  private async beginCreateTaggedTask(context: TagMenuContext): Promise<void> {
    const area = context.sectionId;
    const areaKey = area === "week" ? this.selectedWeekKey : this.selectedDayKey;
    if (!areaKey || !await this.canCreateInArea(area, areaKey)) {
      this.inputTarget = null;
      this.tagCreatePrefix = null;
      return;
    }

    this.activeSection = area;
    const prefix = context.level === "secondary" && context.secondary
      ? `${context.primary} ${context.secondary} `
      : `${context.primary} `;

    if (this.isMobileLayout()) {
      this.inputTarget = `create-${area}`;
      let modal: MobileTaskCreateModal;
      const clearModal = (): void => {
        if (this.taskInputOverlayCleanup === closeModal) {
          this.taskInputOverlayCleanup = null;
        }
        if (this.inputTarget === `create-${area}`) {
          this.inputTarget = null;
        }
        this.tagCreatePrefix = null;
      };
      const closeModal = (): void => {
        modal.close();
      };
      modal = new MobileTaskCreateModal(
        this.app,
        async (name) => {
          const file = this.requireTargetMonthlyFile();
          if (!file) {
            throw new Error("未找到当前月文档");
          }
          await createTopLevelTask(this.store, this.app.vault, file, area, areaKey, name);
          this.inputTarget = null;
          this.tagCreatePrefix = null;
          await this.render();
        },
        clearModal,
        { initialValue: prefix }
      );
      this.taskInputOverlayCleanup = closeModal;
      modal.open();
      return;
    }

    this.inputTarget = `create-${area}`;
    this.tagCreatePrefix = prefix;
    await this.render();
  }

  private openEditTagModal(context: TagMenuContext): void {
    const currentTag = context.level === "secondary" ? context.secondary : context.primary;
    if (!currentTag) {
      return;
    }
    new EditTagModal(this.app, currentTag, async (nextTag) => {
      if (nextTag.length === 0) {
        return;
      }
      if (!isValidSingleTag(nextTag)) {
        new Notice(nextTag.startsWith("#") ? "标签中不能包含空格" : "标签需要以 # 开头");
        return;
      }
      const file = this.requireTargetMonthlyFile();
      if (!file) {
        throw new Error("未找到当前月文档");
      }
      const taskIds = await this.getTaskIdsForSection(context.sectionId);
      await renameTagInTasks(
        this.store,
        this.app.vault,
        file,
        taskIds,
        context.level,
        context.primary,
        currentTag,
        nextTag
      );
      await this.render();
    }).open();
  }

  private async getTaskIdsForSection(sectionId: SectionKind): Promise<string[]> {
    const file = this.requireTargetMonthlyFile();
    if (!file) {
      return [];
    }
    const month = await this.store.getMonth(file);
    if (!month) {
      return [];
    }
    if (sectionId === "week") {
      return this.selectedWeekKey ? flattenOrderArray(getWeekTaskIds(month, this.selectedWeekKey)) : [];
    }
    return this.selectedDayKey ? flattenOrderArray(getDayTaskIds(month, this.selectedDayKey)) : [];
  }

  private async openTagSortModal(sectionId: SectionKind): Promise<void> {
    const file = this.requireTargetMonthlyFile();
    if (!file) return;
    const areaKey = sectionId === "week" ? this.selectedWeekKey : this.selectedDayKey;
    if (!areaKey) return;
    const month = await this.store.getMonth(file);
    if (!month) return;
    const groups = getTagSortGroupsForOrder(
      sectionId === "week" ? getWeekTaskIds(month, areaKey) : getDayTaskIds(month, areaKey),
      month.tasks
    );
    if (groups.length === 0) {
      new Notice("当前范围没有可排序的标签");
      return;
    }
    new TagSortModal(this.app, groups, async (nextGroups) => {
      const latestFile = this.requireTargetMonthlyFile();
      if (!latestFile) return;
      const nextAreaKey = sectionId === "week" ? this.selectedWeekKey : this.selectedDayKey;
      if (!nextAreaKey) return;
      const secondaryOrders: Record<string, string[]> = {};
      for (const group of nextGroups) {
        secondaryOrders[group.primary] = group.secondaries;
      }
      this.suppressStoreRender += 1;
      try {
        await reorderTagGroups(
          this.store,
          this.app.vault,
          latestFile,
          sectionId,
          nextAreaKey,
          nextGroups.map((group) => group.primary),
          secondaryOrders
        );
        this.pendingStoreRender = false;
        await this.refreshTaskAreaOnly(sectionId);
      } finally {
        this.suppressStoreRender = Math.max(0, this.suppressStoreRender - 1);
        if (this.suppressStoreRender === 0 && this.pendingStoreRender) {
          this.pendingStoreRender = false;
          void this.refreshTaskAreaOnly(sectionId);
        }
      }
    }).open();
  }

  private async refreshTaskAreaOnly(sectionId: SectionKind): Promise<void> {
    const viewTime = this.resolveViewTime();
    const file = this.findMonthlyFile(viewTime.month.year, viewTime.month.month);
    const scroller = this.getTaskScroller(sectionId);
    const scrollTop = scroller?.scrollTop ?? null;
    if (!file || !scroller) {
      await this.renderPreservingTaskScroll(sectionId);
      return;
    }
    const monthData = await this.store.ensureMonth(file);

    scroller.empty();
    if (sectionId === "week") {
      const weekTasks = buildWeekTaskTree(
        monthData,
        getWeekTaskIds(monthData, viewTime.selectedWeek.key),
        this.weekTaskFilter
      );
      this.renderTaskList(scroller, weekTasks, "week");
      if (this.inputTarget === "create-week") {
        const createRow = scroller.createDiv({ cls: "task-flow-create-row" });
        this.renderTaskInput(createRow, this.tagCreatePrefix ?? "", async (name) => {
          const targetFile = this.requireTargetMonthlyFile();
          if (!targetFile) return;
          await createTopLevelTask(
            this.store,
            this.app.vault,
            targetFile,
            "week",
            viewTime.selectedWeek.key,
            name
          );
          this.tagCreatePrefix = null;
        });
      }
    } else {
      const dayTasks = groupSourceContexts(
        buildTaskTree(monthData, getDayTaskIds(monthData, viewTime.selectedDay.key))
      );
      this.renderTaskList(scroller, dayTasks, "day");
      if (this.inputTarget === "create-day") {
        const createRow = scroller.createDiv({ cls: "task-flow-create-row" });
        this.renderTaskInput(createRow, this.tagCreatePrefix ?? "", async (name) => {
          const targetFile = this.requireTargetMonthlyFile();
          if (!targetFile) return;
          await createTopLevelTask(
            this.store,
            this.app.vault,
            targetFile,
            "day",
            viewTime.selectedDay.key,
            name
          );
          this.tagCreatePrefix = null;
        });
      }
      this.lockLocalScroll(scroller);
    }

    if (scrollTop !== null) {
      scroller.scrollTop = scrollTop;
    }
    this.scheduleMobileBottomFadePosition();
  }

  private renderWeekFilter(parent: Element): void {
    const control = parent.createDiv({ cls: "task-flow-segmented-control" });
    for (const option of [
      { key: "pending" as const, label: "待安排" },
      { key: "all" as const, label: "全部" }
    ]) {
      const button = control.createEl("button", {
        cls: `task-flow-segmented-option${this.weekTaskFilter === option.key ? " is-active" : ""}`,
        text: option.label
      });
      bindPrimaryAction(button, () => {
        this.weekTaskFilter = option.key;
        this.openProgressTaskId = null;
        void this.render();
      });
    }
  }

  private renderTaskCard(
    parent: Element,
    task: DemoTask,
    sectionId: SectionKind
  ): void {
    const card = parent.createDiv({
      cls: `task-flow-task-card${task.hasWeekSource ? " is-week-sourced" : ""}${(task.children?.length ?? 0) > 0 ? " has-children" : ""}`
    });
    this.renderTaskRow(card, task, 0, task.id, sectionId);
  }

  private renderTaskRow(
    parent: Element,
    task: DemoTask,
    depth: number,
    key: string,
    sectionId: SectionKind
  ): void {
    const row = parent.createDiv({
      cls: `task-flow-task-row${depth === 0 ? " is-parent-row" : " is-child-row"}`
    });
    row.style.setProperty("--task-flow-depth", String(depth));
    row.dataset.taskId = task.id;
    row.dataset.depth = String(depth);
    if (task.actionTaskId) {
      row.dataset.actionTaskId = task.actionTaskId;
    }
    const status = row.createSpan({
      cls: `task-flow-status-dot is-${task.status}${task.special ? " is-special" : ""}${depth === 0 && task.isWeekParent ? " is-week-parent" : ""}`,
      attr: { "aria-label": task.status }
    });
    if (task.status === "done") {
      setIcon(status, "check");
    } else if (task.special) {
      const specialMark = status.createSpan({ cls: "task-flow-status-special-mark" });
      setIcon(specialMark, "check");
    }

    // Status dot click handler — only for Day non-parent tasks
    const isClickable = sectionId === "day"
      && !task.isParentContext
      && !task.isDateGroup
      && !task.children?.length
      && !task.special;
    if (isClickable) {
      status.addClass("is-clickable");
      status.addEventListener("pointerdown", async (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const file = this.requireTargetMonthlyFile();
        if (!file) return;
        const actionId = task.actionTaskId ?? task.id;
        const editor = this.findOpenMarkdownEditor(file);
        const documentOptions = editor ? {
          documentReader: () => editor.getValue(),
          documentWriter: (newContent: string, previousContent: string) => {
            applyEditorLineChanges(editor, previousContent, newContent);
          }
        } : {};
        if (task.status === "todo") {
          await this.copyTasklogTemplate(file, task);
        } else if (task.status === "doing") {
          await changeDayTaskStatus(
            this.store,
            this.app.vault,
            file,
            actionId,
            "done",
            documentOptions
          );
        } else if (task.status === "done") {
          await changeDayTaskStatus(
            this.store,
            this.app.vault,
            file,
            actionId,
            "doing",
            documentOptions
          );
        }
      });
    }

    const name = row.createDiv({ cls: "task-flow-task-name" });
    if (this.inputTarget === `edit-${key}`) {
      const editTaskId = task.actionTaskId ?? task.id;
      this.renderTaskInput(name, task.editName ?? task.name, async (newName) => {
        const file = this.requireTargetMonthlyFile();
        if (!file) return;
        await renameTask(this.store, this.app.vault, file, editTaskId, newName);
      });
    } else {
      name.createDiv({
        cls: "task-flow-task-name-text",
        text: task.name,
        attr: { title: "单击定位，右键编辑" }
      });
      if (depth === 0 && sectionId === "day") {
        let subtitle: HTMLElement | null = null;
        if (task.sourceLabel) {
          subtitle = name.createDiv({
            cls: task.hasWeekSource ? "task-flow-task-source-badge" : "task-flow-task-subtitle",
            text: task.sourceLabel
          });
        } else if (task.hasWeekSource) {
          subtitle = name.createDiv({
            cls: "task-flow-task-source-badge",
            text: "来自周任务"
          });
        } else {
          subtitle = name.createDiv({
            cls: "task-flow-task-subtitle",
            text: "日任务"
          });
        }
        this.renderInlineTaskTag(subtitle, task.inlineTag);
      } else if (task.sourceHint) {
        name.createDiv({ cls: "task-flow-task-subtitle", text: task.sourceHint });
      } else if (task.arrangementLabel) {
        const subtitle = name.createDiv({
          cls: `task-flow-task-subtitle${task.arrangementLabel === "未安排" ? " is-pending" : ""}`,
          text: task.arrangementLabel === "未安排"
            ? "未安排"
            : `已安排 ${task.arrangementLabel}`
        });
        this.renderInlineTaskTag(subtitle, task.inlineTag);
      } else if (task.legacyDateLabel) {
        const subtitle = name.createDiv({ cls: "task-flow-task-subtitle", text: task.legacyDateLabel });
        this.renderInlineTaskTag(subtitle, task.inlineTag);
      } else if (task.inlineTag) {
        const subtitle = name.createDiv({ cls: "task-flow-task-subtitle" });
        this.renderInlineTaskTag(subtitle, task.inlineTag);
      }
    }
    const activateTaskRow = (): void => {
      void this.navigateToTask(task);
    };
    row.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.inputTarget === `edit-${key}`) return;
      const target = event.target as HTMLElement;
      if (isTaskRowControl(target)) return;

      if (!this.isMobileLayout()) {
        event.preventDefault();
        event.stopPropagation();
        activateTaskRow();
        return;
      }

      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      let longPressed = false;
      const clearLongPress = (): void => {
        window.clearTimeout(longPressTimer);
      };
      const openMobileMenu = (): void => {
        longPressed = true;
        const menuEvent = new MouseEvent("contextmenu", {
          bubbles: false,
          cancelable: true,
          clientX: startX,
          clientY: startY
        });
        const actionKey = task.actionTaskId ?? task.id;
        if (this.multiSelect?.sectionId === sectionId) {
          if (!this.multiSelect.selectedKeys.has(actionKey)) {
            this.multiSelect.selectedKeys.add(actionKey);
          }
          void this.openBatchMenu(menuEvent, sectionId);
          return;
        }
        this.openDemoMenu(menuEvent, task, sectionId, actionKey);
      };
      const longPressTimer = window.setTimeout(openMobileMenu, 450);
      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (Math.hypot(deltaX, deltaY) > 10) {
          moved = true;
          clearLongPress();
        }
      };
      const cleanup = (): void => {
        clearLongPress();
        row.removeEventListener("pointermove", move);
        row.removeEventListener("pointerup", finish);
        row.removeEventListener("pointercancel", cancel);
      };
      const finish = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId !== pointerId) return;
        cleanup();
        const deltaX = upEvent.clientX - startX;
        const deltaY = upEvent.clientY - startY;
        if (!longPressed && !moved && Math.hypot(deltaX, deltaY) <= 10) {
          activateTaskRow();
        }
      };
      const cancel = (cancelEvent: PointerEvent): void => {
        if (cancelEvent.pointerId !== pointerId) return;
        cleanup();
      };
      row.addEventListener("pointermove", move);
      row.addEventListener("pointerup", finish);
      row.addEventListener("pointercancel", cancel);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.isMobileLayout()) {
        return;
      }
      const actionKey = task.actionTaskId ?? task.id;
      if (this.multiSelect?.sectionId === sectionId) {
        if (!this.multiSelect.selectedKeys.has(actionKey)) {
          this.multiSelect.selectedKeys.add(actionKey);
        }
        this.openBatchMenu(event, sectionId);
        return;
      }
      this.openDemoMenu(event, task, sectionId, actionKey);
    });

    if (depth === 0 && this.multiSelect?.sectionId !== sectionId) {
      const actions = row.createDiv({ cls: "task-flow-task-actions" });

      if (sectionId === "day" && task.progress) {
        const progressAnchor = actions.createDiv({ cls: "task-flow-progress-anchor" });
        const progressButton = progressAnchor.createEl("button", {
          cls: `task-flow-progress-button${this.openProgressTaskId === task.id ? " is-open" : ""}`,
          attr: { "aria-expanded": this.openProgressTaskId === task.id ? "true" : "false" }
        });
        progressButton.createSpan({
          text: `总进度 ${task.progress.completed}/${task.progress.total}`
        });
        const progressIcon = progressButton.createSpan({ cls: "task-flow-progress-icon" });
        setIcon(progressIcon, this.openProgressTaskId === task.id ? "chevron-down" : "chevron-right");
        bindPrimaryAction(progressButton, () => {
          this.openProgressTaskId = this.openProgressTaskId === task.id ? null : task.id;
          void this.render();
        });
        if (this.openProgressTaskId === task.id) {
          this.renderProgressPopover(progressAnchor, task.progress);
        }
      }

      const addChildButton = actions.createEl("button", {
        cls: "task-flow-task-add-button",
        attr: { "aria-label": `为${task.name}添加子任务` }
      });
      setIcon(addChildButton, "plus");
      bindPrimaryAction(addChildButton, async () => {
        if (
          sectionId === "day"
          && !task.isParentContext
          && !task.children?.length
          && task.status !== "todo"
        ) {
          new Notice("已开始或已完成的任务不能变为父任务");
          return;
        }
        const targetTaskId = task.actionTaskId ?? task.id;
        if (!await this.canCreateChildUnder(targetTaskId)) {
          this.inputTarget = null;
          return;
        }
        const isWeekSourced = task.hasWeekSource && sectionId === "day";

        if (isWeekSourced) {
          const parentId = task.isParentContext ? targetTaskId : task.id;
          this.inputTarget = `child-ws-${parentId}`;
          void this.render();
          return;
        }

        if (task.isParentContext) {
          void (async () => {
            const file = this.requireTargetMonthlyFile();
            if (!file || !this.selectedDayKey) {
              return;
            }
            const sourceId = targetTaskId;
            const continuedId = await continueDayTask(
              this.store, this.app.vault, file, sourceId, this.selectedDayKey
            );
            this.inputTarget = `child-${continuedId}`;
            void this.render();
          })();
          return;
        }

        this.inputTarget = `child-${task.id}`;
        void this.render();
      });
    }

    // Drag handle — always at the right edge, same position for all rows
    if (this.multiSelect?.sectionId !== sectionId) {
      const dragHandle = row.createDiv({ cls: "task-flow-drag-handle" });
      setIcon(dragHandle, "grip-vertical");
      dragHandle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.startDrag(event, task, depth, sectionId, row);
      });
      dragHandle.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    if (this.multiSelect?.sectionId === sectionId) {
      const checkbox = row.createEl("input", {
        cls: "task-flow-task-checkbox",
        type: "checkbox"
      });
      const actionKey = task.actionTaskId ?? task.id;
      checkbox.checked = this.multiSelect.selectedKeys.has(actionKey);
      checkbox.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleTaskSelection(actionKey);
      });
      checkbox.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    for (let index = 0; index < (task.children?.length ?? 0); index += 1) {
      const child = task.children![index];
      this.renderTaskRow(parent, child, depth + 1, child.id, sectionId);
    }

    if (this.inputTarget === `child-${task.id}`) {
      const childInputRow = parent.createDiv({ cls: "task-flow-task-row" });
      childInputRow.addClass("is-child-row");
      childInputRow.style.setProperty("--task-flow-depth", String(depth + 1));
      this.renderTaskInput(childInputRow, "", async (name) => {
        const file = this.requireTargetMonthlyFile();
        if (!file) {
          return;
        }
        await createChildTask(this.store, this.app.vault, file, task.id, name);
      });
    }

    if (this.inputTarget === `child-ws-${task.id}`) {
      const childInputRow = parent.createDiv({ cls: "task-flow-task-row" });
      childInputRow.addClass("is-child-row");
      childInputRow.style.setProperty("--task-flow-depth", String(depth + 1));
      this.renderTaskInput(childInputRow, "", async (name) => {
        const file = this.requireTargetMonthlyFile();
        if (!file || !this.selectedWeekKey) {
          return;
        }
        await createChildTask(this.store, this.app.vault, file, task.id, name);
      });
    }
  }

  private renderInlineTaskTag(parent: Element | null, tagName?: string): void {
    if (!parent || !tagName) {
      return;
    }
    parent.createSpan({
      cls: "task-flow-inline-tag-pill",
      text: tagName
    });
  }

  private renderPriorUnfinished(
    _parent: Element,
    label: string,
    sections: PriorUnfinishedSection[]
  ): void {
    const count = sections.reduce((sum, section) => sum + section.tasks.length, 0);
    if (count === 0) {
      return;
    }
    const shell = document.createElement("div");
    shell.className = "task-flow-prior-unfinished";
    document.body.appendChild(shell);
    this.priorDockEl = shell;

    const trigger = shell.createEl("button", {
      cls: "task-flow-prior-trigger",
      attr: { "aria-expanded": this.priorUnfinishedExpanded ? "true" : "false" }
    });
    const icon = trigger.createSpan({ cls: "task-flow-prior-icon" });
    setIcon(icon, this.priorUnfinishedExpanded ? "chevron-down" : "chevron-right");
    trigger.createSpan({ cls: "task-flow-prior-title", text: label });
    trigger.createSpan({ cls: "task-flow-prior-count", text: String(count) });
    bindPrimaryAction(trigger, () => {
      this.priorUnfinishedExpanded = !this.priorUnfinishedExpanded;
      this.openProgressTaskId = null;
      void this.render();
    });

    if (!this.priorUnfinishedExpanded) {
      this.positionPriorDock(shell);
      return;
    }

    shell.addClass("is-expanded");
    const scroller = shell.createDiv({ cls: "task-flow-prior-scroller" });
    this.lockLocalScroll(scroller);
    for (const section of sections) {
      const group = scroller.createDiv({ cls: "task-flow-prior-group" });
      group.createDiv({ cls: "task-flow-prior-group-title", text: section.title });
      for (const task of section.tasks) {
        this.renderTaskCard(group, task, "day");
      }
    }
    this.positionPriorDock(shell);
  }

  private removePriorDock(): void {
    this.priorDockEl?.remove();
    this.priorDockEl = null;
    const root = this.containerEl.children[1] as HTMLElement | undefined;
    root?.style.setProperty("--tf-prior-dock-height", "0px");
  }

  private positionPriorDock(shell: HTMLElement): void {
    window.requestAnimationFrame(() => {
      const root = this.containerEl.children[1] as HTMLElement | undefined;
      const rootRect = root?.getBoundingClientRect();
      if (!root || !rootRect) {
        return;
      }
      const horizontalPadding = 12;
      shell.style.left = `${rootRect.left + horizontalPadding}px`;
      shell.style.width = `${Math.max(0, rootRect.width - horizontalPadding * 2)}px`;
      const mobileActionOffset = this.isMobileLayout() ? 62 : 0;
      shell.style.bottom = `${this.getObsidianBottomInset() + mobileActionOffset}px`;
      const dockHeight = this.priorUnfinishedExpanded
        ? PRIOR_UNFINISHED_EXPANDED_HEIGHT
        : Math.ceil(shell.getBoundingClientRect().height);
      root.style.setProperty(
        "--tf-prior-dock-height",
        `${dockHeight + 8}px`
      );
    });
  }

  private getObsidianBottomInset(): number {
    const statusBar = document.querySelector<HTMLElement>(".status-bar");
    const statusRect = statusBar?.getBoundingClientRect();
    if (!statusRect || statusRect.height <= 0) {
      return 0;
    }
    if (statusRect.top >= window.innerHeight || statusRect.bottom <= 0) {
      return 0;
    }
    return Math.max(0, Math.ceil(window.innerHeight - statusRect.top));
  }

  private isMobileLayout(): boolean {
    return window.matchMedia("(pointer: coarse) and (max-width: 600px)").matches;
  }

  private setupMobileSectionSwipe(root: HTMLElement, weeks: CalendarWeek[]): void {
    if (!this.isMobileLayout()) {
      return;
    }
    const content = root.querySelector<HTMLElement>(".task-flow-section-content");
    if (!content) {
      return;
    }

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let captured = false;
    content.addEventListener("touchstart", (event) => {
      if (this.activeSection !== "day") {
        tracking = false;
        return;
      }
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest([
        ".task-flow-time-nav",
        ".task-flow-inline-input",
        ".task-flow-drag-handle",
        "button",
        "input",
        "textarea"
      ].join(","))) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
      captured = false;
      // Obsidian registers its back gesture from the initial touch. Isolate
      // eligible task-content gestures before they reach workspace handlers.
      event.stopPropagation();
    }, { capture: true, passive: true });
    content.addEventListener("touchmove", (event) => {
      if (!tracking || event.touches.length !== 1) {
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (!captured) {
        if (Math.abs(deltaX) < 12 || Math.abs(deltaX) < Math.abs(deltaY) * 1.1) {
          return;
        }
        captured = true;
      }
      if (captured) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, { capture: true, passive: false });
    content.addEventListener("touchend", (event) => {
      if (!tracking || event.changedTouches.length !== 1) {
        tracking = false;
        return;
      }
      tracking = false;
      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (Math.abs(deltaX) < 44 || Math.abs(deltaX) < Math.abs(deltaY) * 1.18) {
        return;
      }
      if (this.activeSection === "day") {
        this.switchDayWithinSelectedWeek(weeks, deltaX < 0 ? 1 : -1);
      }
      event.stopPropagation();
    }, { capture: true, passive: true });
    content.addEventListener("touchcancel", (event) => {
      if (tracking) {
        event.stopPropagation();
      }
      tracking = false;
      captured = false;
    }, { capture: true, passive: true });
  }

  private switchDayWithinSelectedWeek(weeks: CalendarWeek[], offset: number): void {
    if (this.switchingSection || this.activeSection !== "day" || !this.selectedWeekKey || !this.selectedDayKey) {
      return;
    }
    const selectedWeek = weeks.find((week) => week.key === this.selectedWeekKey);
    if (!selectedWeek) {
      return;
    }
    const currentIndex = selectedWeek.days.findIndex((day) => day.key === this.selectedDayKey);
    const nextDay = selectedWeek.days[currentIndex + offset];
    if (!nextDay) {
      return;
    }
    this.selectedDayKey = nextDay.key;
    this.inputTarget = null;
    this.openProgressTaskId = null;
    this.multiSelect = null;
    this.priorUnfinishedExpanded = false;
    void this.render();
  }

  private setupMobileScrollIsolation(root: HTMLElement): void {
    this.mobileScrollIsolationCleanup?.();
    this.mobileScrollIsolationCleanup = null;
    if (!this.isMobileLayout()) {
      return;
    }

    let startX = 0;
    let startY = 0;
    let localScroller: HTMLElement | null = null;
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        localScroller = null;
        return;
      }
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      localScroller = (event.target as HTMLElement).closest<HTMLElement>(
        ".task-flow-panel-body, .task-flow-day-task-list, .task-flow-mobile-prior-scroller"
      );
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (Math.abs(deltaY) <= Math.abs(deltaX)) {
        return;
      }
      if (!localScroller) {
        event.preventDefault();
      } else {
        const maxScrollTop = Math.max(0, localScroller.scrollHeight - localScroller.clientHeight);
        const isAtTop = localScroller.scrollTop <= 0;
        const isAtBottom = localScroller.scrollTop >= maxScrollTop - 1;
        const isDraggingDown = deltaY > 0;
        const isDraggingUp = deltaY < 0;
        if (
          maxScrollTop <= 0
          || (isAtTop && isDraggingDown)
          || (isAtBottom && isDraggingUp)
        ) {
          event.preventDefault();
        }
      }
      event.stopPropagation();
    };
    const clearTouch = (): void => {
      localScroller = null;
    };

    root.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    root.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    root.addEventListener("touchend", clearTouch, { capture: true, passive: true });
    root.addEventListener("touchcancel", clearTouch, { capture: true, passive: true });
    this.mobileScrollIsolationCleanup = () => {
      root.removeEventListener("touchstart", onTouchStart, true);
      root.removeEventListener("touchmove", onTouchMove, true);
      root.removeEventListener("touchend", clearTouch, true);
      root.removeEventListener("touchcancel", clearTouch, true);
    };
  }

  private lockLocalScroll(scroller: HTMLElement): void {
    scroller.addEventListener("wheel", (event) => {
      const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
      if (maxScrollTop <= 0) {
        return;
      }
      const isAtTop = scroller.scrollTop <= 0;
      const isAtBottom = scroller.scrollTop >= maxScrollTop - 1;
      const isScrollingUp = event.deltaY < 0;
      const isScrollingDown = event.deltaY > 0;
      if ((isAtTop && isScrollingUp) || (isAtBottom && isScrollingDown)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      scroller.scrollTop += event.deltaY;
    }, { passive: false });
  }

  private renderProgressPopover(parent: Element, progress: TaskProgress): void {
    const popover = parent.createDiv({ cls: "task-flow-progress-popover" });
    const sections: Array<{ status: TaskStatus; title: string }> = [
      { status: "doing", title: "进行中" },
      { status: "todo", title: "未开始" },
      { status: "done", title: "已完成" },
    ];
    for (const section of sections) {
      const items = progress.items.filter((item) => item.status === section.status);
      if (items.length === 0) continue;
      popover.createDiv({ cls: "task-flow-progress-section", text: section.title });
      for (const item of items) {
        this.renderProgressItem(
          popover,
          item.status,
          item.name,
          item.latestDayKey,
          item.otherDayKeys,
        );
      }
    }
  }

  private renderProgressItem(
    parent: Element,
    status: TaskStatus,
    name: string,
    dayKey?: string,
    otherDayKeys: string[] = [],
  ): void {
    const row = parent.createDiv({
      cls: `task-flow-progress-item${dayKey ? " is-arranged" : " is-pending"}`
    });
    if (dayKey) {
      row.createSpan({ cls: "task-flow-progress-date", text: formatDayKey(dayKey) });
    }
    const dot = row.createSpan({
      cls: `task-flow-status-dot is-${status}`,
      attr: { "aria-label": status }
    });
    if (status === "done") {
      setIcon(dot, "check");
    }
    row.createSpan({ cls: "task-flow-progress-name", text: name });
    if (otherDayKeys.length > 0) {
      row.createSpan({
        cls: "task-flow-task-subtitle",
        text: `其他日期 ${otherDayKeys.map(formatDayKey).join("、")}`,
      });
    }
  }

  private renderTaskInput(
    parent: Element,
    value: string,
    onCommit: (name: string) => Promise<void>
  ): void {
    const createRow = parent instanceof HTMLElement
      && parent.classList.contains("task-flow-create-row")
      ? parent
      : null;
    const useMobileOverlay = Boolean(createRow && this.isMobileLayout());
    const overlay = useMobileOverlay ? document.createElement("div") : null;
    const inputHost = useMobileOverlay ? document.createElement("div") : parent;
    const viewRoot = this.containerEl.children[1] as HTMLElement | undefined;
    let overlayScrim: HTMLElement | null = null;
    if (overlay && inputHost instanceof HTMLElement) {
      overlay.className = "task-flow-create-overlay";
      overlayScrim = document.createElement("div");
      overlayScrim.className = "task-flow-create-overlay-scrim";
      inputHost.className = "task-flow-create-overlay-input";
      overlay.append(overlayScrim, inputHost);
      document.body.appendChild(overlay);
      createRow?.addClass("has-create-overlay");
    }
    const input = inputHost.createEl("textarea", {
      cls: "task-flow-inline-input",
      attr: { rows: "1", placeholder: "输入任务名称" }
    });
    input.value = value;
    let disposeOverlay = (): void => {};
    const resizeInput = (): void => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 104)}px`;
      input.style.overflowY = input.scrollHeight > 104 ? "auto" : "hidden";
      if (useMobileOverlay) {
        window.requestAnimationFrame(positionOverlayInput);
      }
    };
    let committed = false;
    let emptyPromptOpen = false;
    const cancel = (): void => {
      this.inputTarget = null;
      this.tagCreatePrefix = null;
      disposeOverlay();
      if (useMobileOverlay) {
        createRow?.remove();
        return;
      }
      // When a render is already in progress, skip calling render() again.
      // Otherwise the nested root.empty() causes a DOM "removeChild" error
      // because the outer render already removed the input from the DOM.
      if (!this.rendering) {
        void this.render();
      }
    };
    const onBlur = (): void => {
      // Don't react to blur while the empty-name modal is open —
      // the modal's callbacks need the input to stay in the DOM.
      if (emptyPromptOpen) {
        return;
      }
      // Silently cancel on empty input — the user clicked away.
      // The empty-name modal is only for explicit Enter press.
      if (input.value.trim().length === 0) {
        cancel();
        return;
      }
      void commit();
    };
    const commit = async (): Promise<void> => {
      if (committed || emptyPromptOpen) {
        return;
      }
      const name = input.value.trim();
      if (!name) {
        emptyPromptOpen = true;
        new EmptyTaskNameModal(this.app, {
          onContinue: () => {
            emptyPromptOpen = false;
            window.setTimeout(() => input.focus());
          },
          onCancel: cancel
        }).open();
        return;
      }

      committed = true;
      input.removeEventListener("blur", onBlur);
      this.suppressStoreRender += 1;
      try {
        await onCommit(name);
        this.inputTarget = null;
        this.pendingStoreRender = false;
        disposeOverlay();
        await this.render();
      } catch (error) {
        committed = false;
        console.error("Task Flow: failed to create task", error);
        new Notice(error instanceof Error ? error.message : "创建任务失败");
        window.setTimeout(() => input.focus());
      } finally {
        this.suppressStoreRender = Math.max(0, this.suppressStoreRender - 1);
        if (this.suppressStoreRender === 0 && this.pendingStoreRender) {
          this.pendingStoreRender = false;
          void this.render();
        }
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        input.removeEventListener("blur", onBlur);
        cancel();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        input.removeEventListener("blur", onBlur);
        void commit();
      }
    });
    input.addEventListener("input", resizeInput);
    input.addEventListener("blur", onBlur);
    const viewport = window.visualViewport;
    const virtualKeyboard = (
      navigator as Navigator & {
        virtualKeyboard?: EventTarget & {
          boundingRect?: DOMRectReadOnly;
        };
      }
    ).virtualKeyboard;
    const nativeKeyboard = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            Keyboard?: {
              addListener?: (
                eventName: "keyboardWillShow" | "keyboardDidShow" | "keyboardWillHide" | "keyboardDidHide",
                listener: (info: { keyboardHeight?: number }) => void
              ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
            };
          };
        };
      }
    ).Capacitor?.Plugins?.Keyboard;
    let nativeKeyboardHeight = 0;
    const nativeKeyboardListeners: Array<{ remove: () => Promise<void> }> = [];
    const positionOverlayInput = (): void => {
      if (!overlay || !(inputHost instanceof HTMLElement) || !createRow?.isConnected) {
        return;
      }
      const rowRect = createRow.getBoundingClientRect();
      const activeLayer = viewRoot?.querySelector<HTMLElement>(
        ".task-flow-section-layer.is-active"
      );
      const referenceCard = activeLayer?.querySelector<HTMLElement>(".task-flow-task-card");
      const activeScroller = activeLayer?.querySelector<HTMLElement>(
        ".task-flow-day-task-list, .task-flow-panel-body"
      );
      const frameRect = referenceCard?.getBoundingClientRect()
        ?? activeScroller?.getBoundingClientRect()
        ?? rowRect;
      const visibleTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewport
        ? viewport.offsetTop + viewport.height
        : window.innerHeight;
      const keyboardRect = virtualKeyboard?.boundingRect;
      const visibleBottom = nativeKeyboardHeight > 0
        ? window.innerHeight - nativeKeyboardHeight
        : keyboardRect && keyboardRect.height > 0
          ? keyboardRect.top
          : viewportBottom;
      const shellHeight = Math.max(inputHost.offsetHeight, input.offsetHeight);
      inputHost.style.left = `${Math.round(frameRect.left)}px`;
      inputHost.style.width = `${Math.round(frameRect.width)}px`;
      inputHost.style.top = `${Math.round(Math.max(
        visibleTop + 12,
        visibleBottom - shellHeight - 12
      ))}px`;
    };
    disposeOverlay = (): void => {
      viewport?.removeEventListener("resize", positionOverlayInput);
      viewport?.removeEventListener("scroll", positionOverlayInput);
      virtualKeyboard?.removeEventListener("geometrychange", positionOverlayInput);
      window.removeEventListener("resize", positionOverlayInput);
      for (const listener of nativeKeyboardListeners.splice(0)) {
        void listener.remove();
      }
      overlay?.remove();
      createRow?.removeClass("has-create-overlay");
      overlayScrim = null;
      if (this.taskInputOverlayCleanup === disposeOverlay) {
        this.taskInputOverlayCleanup = null;
      }
    };
    if (overlay) {
      this.taskInputOverlayCleanup = disposeOverlay;
      overlay.addEventListener("pointerdown", (event) => {
        if (event.target === overlay || event.target === overlayScrim) {
          event.preventDefault();
          input.blur();
        }
      });
      viewport?.addEventListener("resize", positionOverlayInput);
      viewport?.addEventListener("scroll", positionOverlayInput);
      virtualKeyboard?.addEventListener("geometrychange", positionOverlayInput);
      window.addEventListener("resize", positionOverlayInput);
      const listenToNativeKeyboard = (
        eventName: "keyboardWillShow" | "keyboardDidShow" | "keyboardWillHide" | "keyboardDidHide",
        listener: (info: { keyboardHeight?: number }) => void
      ): void => {
        const result = nativeKeyboard?.addListener?.(eventName, listener);
        if (!result) {
          return;
        }
        void Promise.resolve(result).then((handle) => {
          if (overlay?.isConnected) {
            nativeKeyboardListeners.push(handle);
          } else {
            void handle.remove();
          }
        });
      };
      const showKeyboard = (info: { keyboardHeight?: number }): void => {
        nativeKeyboardHeight = Math.max(0, info.keyboardHeight ?? 0);
        positionOverlayInput();
      };
      const hideKeyboard = (): void => {
        nativeKeyboardHeight = 0;
        positionOverlayInput();
      };
      listenToNativeKeyboard("keyboardWillShow", showKeyboard);
      listenToNativeKeyboard("keyboardDidShow", showKeyboard);
      listenToNativeKeyboard("keyboardWillHide", hideKeyboard);
      listenToNativeKeyboard("keyboardDidHide", hideKeyboard);
      positionOverlayInput();
      for (const delay of [80, 220, 500]) {
        window.setTimeout(positionOverlayInput, delay);
      }
    }
    const revealInput = (): void => {
      if (useMobileOverlay) {
        positionOverlayInput();
        return;
      }
      window.setTimeout(() => {
        if (!input.isConnected) {
          return;
        }
        const scroller = input.closest<HTMLElement>(
          ".task-flow-day-task-list, .task-flow-panel-body"
        );
        if (!scroller) {
          return;
        }
        const inputRect = input.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const visibleBottom = viewport
          ? viewport.offsetTop + viewport.height
          : window.innerHeight;
        const effectiveBottom = Math.min(scrollerRect.bottom, visibleBottom);
        const bottomGap = 12;
        if (inputRect.bottom > effectiveBottom - bottomGap) {
          scroller.scrollTop += inputRect.bottom - effectiveBottom + bottomGap;
        } else if (inputRect.top < scrollerRect.top + 8) {
          scroller.scrollTop -= scrollerRect.top + 8 - inputRect.top;
        }
      }, 80);
    };
    const onFocus = (): void => {
      if (!useMobileOverlay) {
        const root = this.containerEl.children[1] as HTMLElement | undefined;
        root?.addClass("is-keyboard-active");
        viewport?.addEventListener("resize", revealInput);
      }
      revealInput();
    };
    const clearFocusState = (): void => {
      if (!useMobileOverlay) {
        const root = this.containerEl.children[1] as HTMLElement | undefined;
        root?.removeClass("is-keyboard-active");
        viewport?.removeEventListener("resize", revealInput);
      }
    };
    input.addEventListener("focus", onFocus);
    input.addEventListener("blur", clearFocusState);
    const focusInput = (): void => {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      resizeInput();
      revealInput();
    };
    if (useMobileOverlay) {
      window.requestAnimationFrame(focusInput);
    } else {
      window.setTimeout(focusInput);
    }
  }
  private renderSectionEmptyState(parent: Element, id: string): void {
    const empty = parent.createDiv({ cls: "task-flow-empty-state" });
    const icon = empty.createDiv({ cls: "task-flow-empty-icon" });
    setIcon(icon, id === "day" ? "clipboard-list" : "inbox");
    empty.createDiv({
      cls: "task-flow-empty-title",
      text: id === "day" ? "暂无日任务" : "暂无任务"
    });
    if (id === "day") {
      empty.createDiv({
        cls: "task-flow-empty-hint",
        text: this.isMobileLayout()
          ? "从周任务中选取，或点击下方添加"
          : "从周任务中选取，或手动添加"
      });
    } else {
      empty.createDiv({
        cls: "task-flow-empty-hint",
        text: this.isMobileLayout() ? "点击下方添加" : "点击右上角添加"
      });
    }
  }

  private async navigateToTask(task: DemoTask): Promise<void> {
    const file = this.requireTargetMonthlyFile();
    if (!file) return;

    const taskId = task.actionTaskId ?? task.id;
    const content = await this.getCurrentDocumentContent(file);
    const tasklogLine = findMatchingLine(
      content,
      new RegExp(`tasklog::\\s*${escapeRegExp(taskId)}\\b`)
    );
    const taskLine = findMatchingLine(
      content,
      new RegExp(`\\^${escapeRegExp(taskId)}\\b`)
    );
    const line = tasklogLine ?? taskLine;
    if (line === null) {
      new Notice("\u672a\u5728\u6587\u6863\u4e2d\u627e\u5230\u8be5\u4efb\u52a1");
      return;
    }

    const activeFile = this.app.workspace.getActiveFile() ?? this.lastActiveMarkdownFile;
    const isActiveTarget = activeFile?.path === file.path;
    let markdownView: MarkdownView | undefined;

    markdownView = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((view): view is MarkdownView =>
        view instanceof MarkdownView && view.file?.path === file.path
      );

    if (!markdownView) {
      const leaf = this.app.workspace.getLeaf(isActiveTarget ? false : "tab");
      await leaf.openFile(file);
      markdownView = leaf.view instanceof MarkdownView ? leaf.view : undefined;
    }
    if (!markdownView) {
      new Notice("\u65e0\u6cd5\u6253\u5f00\u4efb\u52a1\u6240\u5728\u6587\u6863");
      return;
    }

    const mobileLayout = this.isMobileLayout();
    if (mobileLayout) {
      this.app.workspace.setActiveLeaf(markdownView.leaf, { focus: false });
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      this.app.workspace.rightSplit.collapse();
    } else {
      await this.app.workspace.revealLeaf(markdownView.leaf);
    }
    const lineText = markdownView.editor.getLine(line);
    const position = { line, ch: Math.max(0, lineText.search(/\S|$/)) };
    markdownView.editor.setCursor(position);
    if (!mobileLayout) {
      markdownView.editor.focus();
    }
    this.positionAndHighlightEditorLine(markdownView, line);
  }

  private positionAndHighlightEditorLine(markdownView: MarkdownView, line: number): void {
    const codeMirror = (markdownView.editor as Editor & { cm?: EditorView }).cm;
    if (!codeMirror) {
      const position = { line, ch: 0 };
      markdownView.editor.scrollIntoView({ from: position, to: position }, true);
      return;
    }

    const documentLine = codeMirror.state.doc.line(line + 1);
    const viewportHeight = codeMirror.scrollDOM.clientHeight;
    const yMargin = Math.max(24, Math.min(viewportHeight - 1, viewportHeight * 0.28));
    codeMirror.dispatch({
      effects: EditorView.scrollIntoView(documentLine.from, {
        y: "start",
        yMargin
      })
    });

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!codeMirror.state.field(taskFlowJumpHighlightField, false)) {
          codeMirror.dispatch({
            effects: StateEffect.appendConfig.of(taskFlowJumpHighlightField)
          });
        }
        codeMirror.dispatch({
          effects: setTaskFlowJumpHighlight.of(null)
        });
        window.requestAnimationFrame(() => {
          codeMirror.dispatch({
            effects: setTaskFlowJumpHighlight.of({
              from: documentLine.from,
              to: documentLine.to
            })
          });
        });

        const previousHandler = taskFlowJumpHighlightClearHandlers.get(codeMirror);
        if (previousHandler) {
          codeMirror.contentDOM.removeEventListener("pointerdown", previousHandler, true);
        }
        const clearHighlight = (): void => {
          codeMirror.dispatch({ effects: setTaskFlowJumpHighlight.of(null) });
          taskFlowJumpHighlightClearHandlers.delete(codeMirror);
        };
        taskFlowJumpHighlightClearHandlers.set(codeMirror, clearHighlight);
        codeMirror.contentDOM.addEventListener("pointerdown", clearHighlight, {
          capture: true,
          once: true
        });
      });
    });
  }

  private showWeekPicker(
    anchor: HTMLElement,
    weeks: CalendarWeek[],
    selectedKey: string,
    onSelect: (key: string) => void,
  ): void {
    this.removeWeekPickerElement();
    const isMobile = window.matchMedia("(pointer: coarse) and (max-width: 600px)").matches;
    this.timePickerMode = "week";
    this.timePickerBrowseMonth = monthFromWeekKey(selectedKey);

    if (isMobile) {
      const backdrop = document.createElement("div");
      backdrop.className = "task-flow-week-sheet-backdrop";
      const sheet = backdrop.createDiv({ cls: "task-flow-week-sheet" });
      sheet.createDiv({ cls: "task-flow-week-sheet-handle" });
      const host = sheet.createDiv({ cls: "task-flow-time-picker-host" });
      this.renderTimePicker(host, weeks, selectedKey, onSelect);
      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop) {
          this.weekPickerOpen = false;
          this.removeWeekPickerElement();
          void this.render();
        }
      });
      document.body.appendChild(backdrop);
      this.weekPickerEl = backdrop;
      window.requestAnimationFrame(() => backdrop.addClass("is-open"));
      return;
    }

    const popover = document.createElement("div");
    popover.className = "task-flow-week-popover";
    const host = popover.createDiv({ cls: "task-flow-time-picker-host" });
    this.renderTimePicker(host, weeks, selectedKey, onSelect);
    document.body.appendChild(popover);
    this.weekPickerEl = popover;

    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = this.containerEl.getBoundingClientRect();
    const width = Math.min(
      380,
      Math.max(300, panelRect.width - 20),
      window.innerWidth - 16,
    );
    popover.style.width = `${width}px`;
    const popoverRect = popover.getBoundingClientRect();
    const left = Math.min(
      Math.max(anchorRect.left, 8),
      window.innerWidth - popoverRect.width - 8,
    );
    const preferredTop = anchorRect.bottom + 7;
    const top = preferredTop + popoverRect.height <= window.innerHeight - 8
      ? preferredTop
      : Math.max(8, anchorRect.top - popoverRect.height - 7);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    const closeHandler = (event: PointerEvent): void => {
      const currentAnchor = this.getWeekPickerAnchor();
      if (
        popover.contains(event.target as Node)
        || anchor.contains(event.target as Node)
        || currentAnchor?.contains(event.target as Node)
      ) {
        return;
      }
      this.weekPickerOpen = false;
      this.removeWeekPickerElement();
      window.setTimeout(() => void this.render());
    };
    window.setTimeout(() => document.addEventListener("pointerdown", closeHandler, true));
    this.weekPickerCleanup = () => {
      document.removeEventListener("pointerdown", closeHandler, true);
    };
  }

  private renderTimePicker(
    host: HTMLElement,
    weeks: CalendarWeek[],
    selectedKey: string,
    onSelect: (key: string) => void,
  ): void {
    host.empty();
    const browseMonth = this.timePickerBrowseMonth ?? monthFromWeekKey(selectedKey);
    this.timePickerBrowseMonth = browseMonth;
    const mode = this.timePickerMode;
    const picker = host.createDiv({ cls: `task-flow-time-picker is-${mode}` });

    const tabs = picker.createDiv({ cls: "task-flow-time-picker-tabs" });
    for (const item of [
      { mode: "week" as const, label: "\u5468" },
      { mode: "month" as const, label: "\u6708" },
      { mode: "year" as const, label: "\u5e74" },
    ]) {
      const tab = tabs.createEl("button", {
        cls: `task-flow-time-picker-tab${mode === item.mode ? " is-active" : ""}`,
        text: item.label,
        attr: { "aria-pressed": mode === item.mode ? "true" : "false" }
      });
      bindPrimaryAction(tab, () => {
        this.timePickerMode = item.mode;
        this.renderTimePicker(host, weeks, selectedKey, onSelect);
      });
    }

    const header = picker.createDiv({ cls: "task-flow-week-calendar-header" });
    const prevButton = header.createEl("button", {
      cls: "task-flow-time-picker-nav",
      attr: { "aria-label": "\u4e0a\u4e00\u4e2a" }
    });
    setIcon(prevButton, "chevron-left");
    header.createDiv({
      cls: "task-flow-week-calendar-title task-flow-time-picker-title-text",
      text: this.getTimePickerTitle(browseMonth, mode)
    });
    const todayButton = header.createEl("button", {
      cls: `task-flow-time-picker-today${this.isTimePickerBrowsingToday(browseMonth, mode, selectedKey) ? " is-hidden" : ""}`,
      text: "\u4eca\u5929",
      attr: { "aria-label": "\u56de\u5230\u4eca\u5929" }
    });
    const nextButton = header.createEl("button", {
      cls: "task-flow-time-picker-nav",
      attr: { "aria-label": "\u4e0b\u4e00\u4e2a" }
    });
    setIcon(nextButton, "chevron-right");

    bindPrimaryAction(prevButton, () => {
      this.shiftTimePickerBrowse(-1);
      this.renderTimePicker(host, weeks, selectedKey, onSelect);
    });
    bindPrimaryAction(nextButton, () => {
      this.shiftTimePickerBrowse(1);
      this.renderTimePicker(host, weeks, selectedKey, onSelect);
    });
    bindPrimaryAction(todayButton, () => {
      void this.jumpToToday();
    });
    if (mode === "week") {
      this.renderTimePickerWeekMode(picker, browseMonth, selectedKey, onSelect);
      return;
    }
    if (mode === "month") {
      this.renderTimePickerMonthMode(picker, browseMonth, host, weeks, selectedKey, onSelect);
      return;
    }
    this.renderTimePickerYearMode(picker, browseMonth, host, weeks, selectedKey, onSelect);
  }

  private getTimePickerTitle(month: MonthlyFile, mode: TimePickerMode): string {
    if (mode === "week") return `${month.year}\u5e74${month.month}\u6708`;
    if (mode === "month") return `${month.year}\u5e74`;
    const start = getYearPageStart(month.year);
    return `${start}-${start + 11}`;
  }

  private isTimePickerBrowsingToday(month: MonthlyFile, mode: TimePickerMode, selectedKey: string): boolean {
    if (mode !== "week") {
      return false;
    }
    const todayWeekKey = computeWeekKey(formatDateKey(new Date()));
    return selectedKey === todayWeekKey && isSameMonth(month, monthFromWeekKey(todayWeekKey));
  }

  private shiftTimePickerBrowse(offset: number): void {
    const browseMonth = this.timePickerBrowseMonth ?? monthFromWeekKey(this.selectedWeekKey ?? computeWeekKey(formatDateKey(new Date())));
    if (this.timePickerMode === "week") {
      this.timePickerBrowseMonth = shiftMonth(browseMonth, offset);
      return;
    }
    if (this.timePickerMode === "month") {
      this.timePickerBrowseMonth = { year: browseMonth.year + offset, month: browseMonth.month };
      return;
    }
    this.timePickerBrowseMonth = { year: browseMonth.year + offset * 12, month: browseMonth.month };
  }

  private renderTimePickerWeekMode(
    parent: HTMLElement,
    browseMonth: MonthlyFile,
    selectedKey: string,
    onSelect: (key: string) => void,
  ): void {
    const hint = parent.createDiv({ cls: "task-flow-week-calendar-hint", text: "\u9009\u62e9\u6574\u5468" });
    hint.setAttribute("aria-hidden", "true");
    const weekdays = parent.createDiv({ cls: "task-flow-week-calendar-weekdays" });
    for (const label of ["\u4e00", "\u4e8c", "\u4e09", "\u56db", "\u4e94", "\u516d", "\u65e5"]) {
      weekdays.createSpan({ text: label });
    }

    const rows = parent.createDiv({ cls: "task-flow-week-calendar-rows" });
    const monthWeeks = buildMonthWeeks(browseMonth);
    const todayKey = formatDateKey(new Date());
    for (const week of monthWeeks) {
      const ownerMonth = monthFromWeekKey(week.key);
      const isOwnerMonth = ownerMonth.year === browseMonth.year && ownerMonth.month === browseMonth.month;
      const row = rows.createEl("button", {
        cls: `task-flow-week-calendar-row${week.key === selectedKey ? " is-active" : ""}${isOwnerMonth ? "" : " is-other-owner"}`,
        attr: {
          "aria-label": `\u9009\u62e9 ${week.label}`,
          "aria-pressed": week.key === selectedKey ? "true" : "false",
          "data-week-key": week.key,
        },
      });
      const days = row.createDiv({ cls: "task-flow-week-calendar-days" });
      for (const day of week.days) {
        days.createSpan({
          cls: [
            day.date.getMonth() + 1 !== browseMonth.month ? "is-outside-month" : "",
            day.key === todayKey ? "is-today" : "",
          ].filter(Boolean).join(" "),
          text: String(day.date.getDate()),
        });
      }
      if (!isOwnerMonth) {
        row.createSpan({ cls: "task-flow-week-owner-label", text: `\u5199\u5165 ${formatMonthTitle(ownerMonth)}` });
      }
      bindPrimaryAction(row, () => onSelect(week.key));
    }
    for (let index = monthWeeks.length; index < 6; index += 1) {
      const row = rows.createDiv({ cls: "task-flow-week-calendar-row is-placeholder" });
      row.setAttribute("aria-hidden", "true");
      const days = row.createDiv({ cls: "task-flow-week-calendar-days" });
      for (let day = 0; day < 7; day += 1) {
        days.createSpan({ text: "\u00a0" });
      }
    }
  }

  private renderTimePickerMonthMode(
    parent: HTMLElement,
    browseMonth: MonthlyFile,
    host: HTMLElement,
    weeks: CalendarWeek[],
    selectedKey: string,
    onSelect: (key: string) => void,
  ): void {
    const grid = parent.createDiv({ cls: "task-flow-time-picker-month-grid" });
    for (let month = 1; month <= 12; month += 1) {
      const button = grid.createEl("button", {
        cls: `task-flow-time-picker-month${month === browseMonth.month ? " is-active" : ""}`,
        text: `${month}\u6708`,
        attr: { "aria-pressed": month === browseMonth.month ? "true" : "false" }
      });
      bindPrimaryAction(button, () => {
        this.timePickerBrowseMonth = { year: browseMonth.year, month };
        this.timePickerMode = "week";
        this.renderTimePicker(host, weeks, selectedKey, onSelect);
      });
    }
  }

  private renderTimePickerYearMode(
    parent: HTMLElement,
    browseMonth: MonthlyFile,
    host: HTMLElement,
    weeks: CalendarWeek[],
    selectedKey: string,
    onSelect: (key: string) => void,
  ): void {
    const start = getYearPageStart(browseMonth.year);
    const grid = parent.createDiv({ cls: "task-flow-time-picker-year-grid" });
    for (let year = start; year < start + 12; year += 1) {
      const button = grid.createEl("button", {
        cls: `task-flow-time-picker-year${year === browseMonth.year ? " is-active" : ""}`,
        text: String(year),
        attr: { "aria-pressed": year === browseMonth.year ? "true" : "false" }
      });
      bindPrimaryAction(button, () => {
        this.timePickerBrowseMonth = { year, month: browseMonth.month };
        this.timePickerMode = "month";
        this.renderTimePicker(host, weeks, selectedKey, onSelect);
      });
    }
  }

  private restoreWeekPicker(weeks: CalendarWeek[]): void {
    window.requestAnimationFrame(() => {
      if (!this.weekPickerOpen || !this.selectedWeekKey) {
        return;
      }
      const anchor = this.getWeekPickerAnchor();
      if (!anchor) {
        this.weekPickerOpen = false;
        return;
      }
      this.showWeekPicker(
        anchor,
        weeks,
        this.selectedWeekKey,
        (key) => this.selectWeek(weeks, key)
      );
    });
  }

  private refreshOpenWeekPicker(weeks: CalendarWeek[], selectedKey: string): void {
    const host = this.weekPickerEl?.querySelector<HTMLElement>(".task-flow-time-picker-host");
    if (!host) {
      return;
    }
    this.renderTimePicker(
      host,
      weeks,
      selectedKey,
      (key) => this.selectWeek(weeks, key)
    );
  }

  private getWeekPickerAnchor(): HTMLElement | null {
    const root = this.containerEl.children[1] as HTMLElement | undefined;
    const selector = this.weekPickerTrigger === "day-switch"
      ? ".task-flow-section-switch-option:last-of-type"
      : this.isMobileLayout()
        ? ".task-flow-mobile-time-button"
        : ".task-flow-unified-time-pill";
    return root?.querySelector<HTMLElement>(selector) ?? null;
  }

  private closeWeekPicker(): void {
    this.weekPickerOpen = false;
    this.removeWeekPickerElement();
  }

  private removeWeekPickerElement(): void {
    this.weekPickerCleanup?.();
    this.weekPickerCleanup = null;
    this.weekPickerEl?.remove();
    this.weekPickerEl = null;
  }

  private showCustomMenu(x: number, y: number, items: ContextMenuItem[]): void {
    this.closeCustomMenu();
    const isMobile = window.matchMedia("(pointer: coarse)").matches;

    if (isMobile) {
      this.showBottomSheet(items);
      return;
    }

    const menu = document.createElement("div");
    menu.className = "task-flow-custom-menu";
    for (const item of items) {
      const menuItem = menu.createDiv({
        cls: `task-flow-custom-menu-item${item.danger ? " is-danger" : ""}${item.disabled ? " is-disabled" : ""}`
      });
      if (item.icon) {
        setIcon(menuItem.createSpan({ cls: "task-flow-custom-menu-icon" }), item.icon);
      }
      menuItem.createSpan({ cls: "task-flow-custom-menu-label", text: item.label });
      if (!item.disabled) {
        menuItem.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeCustomMenu();
          item.onClick?.();
        });
      }
    }
    document.body.appendChild(menu);
    // Adjust position to stay within viewport
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const adjustedX = Math.min(x, vw - rect.width - 4);
    const adjustedY = Math.min(y, vh - rect.height - 4);
    menu.style.left = `${Math.max(adjustedX, 4)}px`;
    menu.style.top = `${Math.max(adjustedY, 4)}px`;
    this.customMenuEl = menu;

    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.closeCustomMenu();
        document.removeEventListener("click", closeHandler, true);
        document.removeEventListener("contextmenu", closeHandler, true);
        document.removeEventListener("keydown", keyHandler, true);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.closeCustomMenu();
        document.removeEventListener("click", closeHandler, true);
        document.removeEventListener("contextmenu", closeHandler, true);
        document.removeEventListener("keydown", keyHandler, true);
      }
    };
    setTimeout(() => {
      document.addEventListener("click", closeHandler, true);
      document.addEventListener("contextmenu", closeHandler, true);
      document.addEventListener("keydown", keyHandler, true);
    }, 0);
  }

  private showBottomSheet(items: ContextMenuItem[]): void {
    const backdrop = document.createElement("div");
    backdrop.className = "task-flow-bottom-sheet-backdrop";
    const sheet = backdrop.createDiv({ cls: "task-flow-bottom-sheet" });

    for (const item of items) {
      const btn = sheet.createDiv({
        cls: `task-flow-bottom-sheet-item${item.danger ? " is-danger" : ""}${item.disabled ? " is-disabled" : ""}`
      });
      if (item.icon) {
        setIcon(btn.createSpan({ cls: "task-flow-bottom-sheet-icon" }), item.icon);
      }
      btn.createSpan({ cls: "task-flow-bottom-sheet-label", text: item.label });
      if (!item.disabled) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeCustomMenu();
          item.onClick?.();
        });
      }
    }

    const cancelBtn = sheet.createDiv({ cls: "task-flow-bottom-sheet-cancel", text: "取消" });
    cancelBtn.addEventListener("click", () => this.closeCustomMenu());

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.closeCustomMenu();
    });

    document.body.appendChild(backdrop);
    this.customMenuEl = backdrop;

    // Animate in
    requestAnimationFrame(() => {
      backdrop.classList.add("is-open");
    });
  }

  private closeCustomMenu(): void {
    this.customMenuEl?.remove();
    this.customMenuEl = null;
  }

  private openDemoMenu(
    event: MouseEvent,
    task: DemoTask,
    sectionId: SectionKind,
    key: string
  ): void {
    const actionTask = key === task.id ? task : { ...task, id: key };
    const items: ContextMenuItem[] = [{
      label: "编辑",
      icon: "pencil",
      onClick: () => { void this.beginEditTask(task, key); }
    }, {
      label: "删除",
      icon: "trash-2",
      danger: true,
      onClick: () => { void this.confirmAndDelete(actionTask); }
    }];
    let addToWeekItem: ContextMenuItem | null = null;

    if (sectionId === "week") {
      items.push({ label: "添加到指定日期", icon: "calendar-plus", onClick: () => { this.openWeekTaskDatePicker(task); } });
    } else {
      if (!actionTask.hasWeekSource) {
        addToWeekItem = {
          label: "添加到周任务",
          icon: "arrow-up",
          onClick: () => { void this.joinDayTaskToWeek(actionTask); }
        };
      }
      const operation = getDayOperationAvailability(task);
      if (operation === "continue") {
        items.push({ label: "延续到指定日期", icon: "forward", onClick: () => { this.continueDayTask(actionTask); } });
      } else if (operation === "move") {
        if (task.isParentContext && task.actionTaskId && this.selectedDayKey) {
          items.push({ label: "移动子任务到指定日期", icon: "calendar", onClick: () => { this.openMoveProjectionChildrenPicker(task.actionTaskId!, this.selectedDayKey!); } });
        } else {
          items.push({ label: "移动到指定日期", icon: "calendar", onClick: () => { this.moveDayTaskToDatePicker(actionTask); } });
        }
      } else {
        items.push({ label: "状态不一致，需分别处理", icon: "info", disabled: true });
      }
    }

    items.push({
      label: "多选",
      icon: "list-checks",
      onClick: () => {
        this.multiSelect = { sectionId, selectedKeys: new Set([key]) };
        void this.renderPreservingTaskScroll(sectionId);
      }
    });
    if (addToWeekItem) {
      items.push(addToWeekItem);
    }

    this.showCustomMenu(event.clientX, event.clientY, items);
  }

  private async openBatchMenu(event: MouseEvent, sectionId: SectionKind): Promise<void> {
    const items: ContextMenuItem[] = [];

    if (sectionId === "week") {
      items.push({ label: "添加到指定日期", icon: "calendar-plus", onClick: () => { this.openBatchWeekDatePicker(); } });
    } else {
      items.push({ label: "添加到周任务", icon: "arrow-up", onClick: () => { void this.joinBatchDayTasksToWeek(); } });
      const availability = await this.getBatchDayOperationAvailability();
      if (availability === "continue") {
        items.push({ label: "延续到指定日期", icon: "forward", onClick: () => { this.openBatchDayDatePicker("continue"); } });
      } else if (availability === "move") {
        items.push({ label: "移动到指定日期", icon: "calendar", onClick: () => { this.openBatchDayDatePicker("move"); } });
      } else {
        items.push({ label: "所选任务状态不一致，请分别处理", icon: "info", disabled: true });
      }
    }

    items.push({
      label: "删除",
      icon: "trash-2",
      danger: true,
      onClick: () => { void this.confirmAndBatchDelete(); }
    });
    this.showCustomMenu(event.clientX, event.clientY, items);
  }

  private async getBatchDayOperationAvailability(): Promise<"move" | "continue" | "none"> {
    const file = this.requireTargetMonthlyFile();
    const selectedIds = [...(this.multiSelect?.selectedKeys ?? [])];
    if (!file || selectedIds.length === 0) return "none";
    const month = await this.store.getMonth(file);
    if (!month) return "none";

    const rootIds = selectedIds.filter((id) => {
      const parentId = month.tasks[id]?.parentId;
      return !parentId || !selectedIds.includes(parentId);
    });
    const statuses: TaskStatus[] = [];
    for (const id of rootIds) {
      const task = month.tasks[id];
      if (!task || task.area !== "day") return "none";
      if (task.childIds.length > 0) {
        for (const childId of task.childIds) {
          const child = month.tasks[childId];
          if (child) statuses.push(child.status);
        }
      } else {
        statuses.push(task.status);
      }
    }
    return statuses.length > 0 && statuses.every((status) => status === "todo")
      ? "move"
      : statuses.length > 0 && statuses.every((status) => status === "doing")
        ? "continue"
        : "none";
  }

  private openBatchDayDatePicker(operation: "move" | "continue"): void {
    const ctx = this.getSelectedWeekContext();
    if (!ctx) return;
    const selectedIds = [...(this.multiSelect?.selectedKeys ?? [])];
    new DateChoiceModal(
      this.app,
      operation === "move" ? "移动到指定日期" : "延续到指定日期",
      ctx.days,
      async (dayKey) => {
        const month = await this.store.getMonth(ctx.file);
        if (!month) return;
        const rootIds = selectedIds.filter((id) => {
          const parentId = month.tasks[id]?.parentId;
          return !parentId || !selectedIds.includes(parentId);
        });
        for (const taskId of rootIds) {
          if (operation === "move") {
            await moveDayTask(this.store, this.app.vault, ctx.file, taskId, dayKey);
          } else {
            await continueDayTask(this.store, this.app.vault, ctx.file, taskId, dayKey);
          }
        }
        this.multiSelect = null;
        this.selectedDayKey = dayKey;
        await this.render();
      },
    ).open();
  }

  private toggleTaskSelection(key: string): void {
    if (!this.multiSelect) {
      return;
    }
    if (this.multiSelect.selectedKeys.has(key)) {
      this.multiSelect.selectedKeys.delete(key);
    } else {
      this.multiSelect.selectedKeys.add(key);
    }
    void this.renderPreservingTaskScroll(this.multiSelect.sectionId);
  }

  private async renderPreservingTaskScroll(sectionId: SectionKind): Promise<void> {
    const scrollTop = this.getTaskScroller(sectionId)?.scrollTop ?? null;
    await this.render();
    if (scrollTop === null) {
      return;
    }
    window.requestAnimationFrame(() => {
      const scroller = this.getTaskScroller(sectionId);
      if (scroller) {
        scroller.scrollTop = scrollTop;
      }
    });
  }

  private getTaskScroller(sectionId: SectionKind): HTMLElement | null {
    const root = this.containerEl.children[1] as HTMLElement | undefined;
    const selector = sectionId === "day"
      ? ".is-day-layer .task-flow-day-task-list"
      : ".is-week-layer .task-flow-panel-body";
    return root?.querySelector<HTMLElement>(selector) ?? null;
  }

  private toggleSection(id: string): void {
    if (this.collapsedSections.has(id)) {
      this.collapsedSections.delete(id);
    } else {
      this.collapsedSections.add(id);
    }
    void this.render();
  }

  private startDrag(
    event: PointerEvent,
    task: DemoTask,
    depth: number,
    sectionId: SectionKind,
    row: HTMLElement
  ): void {
    const taskId = task.actionTaskId ?? task.id;
    this.dragState = {
      taskId: task.id,
      actionTaskId: taskId,
      depth,
      sectionId,
      startY: event.clientY,
      row
    };
    row.addClass("is-dragging");
    row.setPointerCapture(event.pointerId);

    // Create drop indicator
    this.dropIndicator = document.createElement("div");
    this.dropIndicator.className = "task-flow-drop-indicator";
    document.body.appendChild(this.dropIndicator);

    const onMove = (e: PointerEvent) => this.handleDragMove(e);
    const onUp = (e: PointerEvent) => this.handleDragEnd(e, onMove, onUp);
    row.addEventListener("pointermove", onMove);
    row.addEventListener("pointerup", onUp);
    row.addEventListener("pointercancel", onUp);
  }

  private handleDragMove(event: PointerEvent): void {
    if (!this.dragState || !this.dropIndicator) return;

    // Require minimum vertical movement before activating drag reorder.
    // This prevents accidental reorders from a stationary click or tiny
    // movements that happen when aiming for a specific drag handle.
    const dy = event.clientY - this.dragState.startY;
    if (Math.abs(dy) < 8) {
      this.dropIndicator.style.display = "none";
      return;
    }

    const container = this.findSiblingContainer(this.dragState.row, this.dragState.depth);
    if (!container) return;

    const targetDepth = String(this.dragState.depth);
    const siblings = Array.from(
      container.querySelectorAll<HTMLElement>(`.task-flow-task-row[data-depth="${targetDepth}"]`)
    ).filter((r) => r !== this.dragState!.row && isRealTaskRow(r));

    if (siblings.length === 0) {
      this.dropIndicator.style.display = "none";
      return;
    }

    let targetRow: HTMLElement | null = null;
    let insertBefore = true;

    for (const sibling of siblings) {
      const rect = sibling.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (event.clientY <= rect.bottom) {
        targetRow = sibling;
        insertBefore = event.clientY < midY;
        break;
      }
    }

    if (!targetRow && siblings.length > 0) {
      targetRow = siblings[siblings.length - 1];
      insertBefore = false;
    }

    if (targetRow) {
      const targetRect = targetRow.getBoundingClientRect();
      const indicatorY = insertBefore
        ? targetRect.top
        : findCardBottom(targetRow, parseInt(targetDepth, 10));
      this.dropIndicator.style.display = "block";
      this.dropIndicator.style.top = `${indicatorY - 1}px`;
      this.dropIndicator.style.left = `${targetRect.left}px`;
      this.dropIndicator.style.width = `${targetRect.width}px`;
      this.dropIndicator.dataset.targetTaskId = targetRow.dataset.taskId ?? "";
      this.dropIndicator.dataset.insertBefore = insertBefore ? "1" : "0";
    }
  }

  private async handleDragEnd(
    event: PointerEvent,
    onMove: (e: PointerEvent) => void,
    onUp: (e: PointerEvent) => void
  ): Promise<void> {
    if (this.dragState) {
      this.dragState.row.removeEventListener("pointermove", onMove);
      this.dragState.row.removeEventListener("pointerup", onUp);
      this.dragState.row.removeEventListener("pointercancel", onUp);
      this.dragState.row.releasePointerCapture(event.pointerId);
      this.dragState.row.removeClass("is-dragging");
    }

    if (this.dropIndicator) {
      const targetTaskId = this.dropIndicator.dataset.targetTaskId;
      const insertBefore = this.dropIndicator.dataset.insertBefore === "1";
      this.dropIndicator.remove();
      this.dropIndicator = null;

      if (targetTaskId && this.dragState) {
        try {
          const file = this.requireTargetMonthlyFile();
          if (file) {
            const month = await this.store.getMonth(file);
            if (month) {
              const targetTask = month.tasks[targetTaskId];
              const draggedTask = month.tasks[this.dragState.actionTaskId];
              if (targetTask && draggedTask) {
                const targetIndex = resolveDataIndex(month, targetTask, draggedTask, insertBefore);
                if (targetIndex >= 0) {
                  await reorderTask(this.store, this.app.vault, file, this.dragState.actionTaskId, targetIndex);
                }
              }
            }
          }
        } catch (error) {
          console.error("Task Flow: reorder failed", error);
          new Notice(error instanceof Error ? error.message : "排序失败");
        }
      }
    }

    this.dragState = null;
  }

  // Find the DOM container that holds all siblings of a task row.
  // For top-level tasks (depth 0), siblings are spread across cards
  // inside the section body. For child tasks, siblings share the same
  // parent card.
  private findSiblingContainer(row: HTMLElement, depth: number): HTMLElement | null {
    if (depth === 0) {
      return row.closest(".task-flow-tag-task-scope, .task-flow-panel-body, .task-flow-day-task-list") as HTMLElement | null;
    }
    return row.parentElement;
  }

  private setupTimeNavigation(
    sectionId: SectionKind,
    shell: HTMLElement,
    scroller: HTMLElement,
    activeButton: HTMLButtonElement | null,
    selectDay: Map<HTMLButtonElement, () => void>
  ): void {
    const leftButton = shell.querySelector<HTMLButtonElement>(".task-flow-time-edge.is-left");
    const rightButton = shell.querySelector<HTMLButtonElement>(".task-flow-time-edge.is-right");
    const updateEdges = (): void => {
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const canScrollLeft = scroller.scrollLeft > 2;
      const canScrollRight = scroller.scrollLeft < maxScroll - 2;
      shell.toggleClass("can-scroll-left", canScrollLeft);
      shell.toggleClass("can-scroll-right", canScrollRight);
      if (leftButton) leftButton.disabled = !canScrollLeft;
      if (rightButton) rightButton.disabled = !canScrollRight;
    };
    scroller.addEventListener("scroll", () => {
      this.timeNavScrollLeft[sectionId] = scroller.scrollLeft;
      updateEdges();
    }, { passive: true });
    const isolateTouch = (event: TouchEvent): void => {
      event.stopPropagation();
    };
    scroller.addEventListener("touchstart", isolateTouch, { passive: true });
    scroller.addEventListener("touchmove", isolateTouch, { passive: true });
    scroller.addEventListener("touchend", isolateTouch, { passive: true });
    const step = 172;
    bindPrimaryAction(leftButton!, () => {
      scroller.scrollBy({ left: -step, behavior: "smooth" });
    });
    bindPrimaryAction(rightButton!, () => {
      scroller.scrollBy({ left: step, behavior: "smooth" });
    });
    const usesNativeTouchScroll = window.matchMedia("(pointer: coarse)").matches;
    if (usesNativeTouchScroll) {
      for (const [button, select] of selectDay) {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          select();
        });
      }
    } else {
      scroller.addEventListener("wheel", (event) => {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
        if (delta === 0) return;

        const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const canMove = delta < 0
          ? scroller.scrollLeft > 0
          : scroller.scrollLeft < maxScroll;
        if (!canMove) return;

        event.preventDefault();
        event.stopPropagation();
        scroller.scrollLeft += delta;
      }, { passive: false });
      let pointerId: number | null = null;
      let startX = 0;
      let startY = 0;
      let startScrollLeft = 0;
      let dragged = false;
      let startButton: HTMLButtonElement | null = null;
      scroller.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || pointerId !== null) return;
        event.preventDefault();
        event.stopPropagation();
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        startScrollLeft = scroller.scrollLeft;
        dragged = false;
        startButton = (event.target as HTMLElement)
          .closest<HTMLButtonElement>(".task-flow-inline-option");
        scroller.setPointerCapture(event.pointerId);
      }, { capture: true });
      scroller.addEventListener("pointermove", (event) => {
        if (event.pointerId !== pointerId) return;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        if (!dragged) {
          if (Math.hypot(deltaX, deltaY) < 5) return;
          dragged = true;
          scroller.addClass("is-dragging");
        }
        event.preventDefault();
        event.stopPropagation();
        scroller.scrollLeft = startScrollLeft - deltaX;
      });
      const finishPointer = (event: PointerEvent, cancelled = false): void => {
        if (event.pointerId !== pointerId) return;
        const wasDragged = dragged;
        const button = startButton;
        pointerId = null;
        dragged = false;
        startButton = null;
        scroller.removeClass("is-dragging");
        if (scroller.hasPointerCapture(event.pointerId)) {
          scroller.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
        if (wasDragged || cancelled || !button) return;

        const buttonRect = button.getBoundingClientRect();
        const endedInsideButton = event.clientX >= buttonRect.left
          && event.clientX <= buttonRect.right
          && event.clientY >= buttonRect.top
          && event.clientY <= buttonRect.bottom;
        if (endedInsideButton) selectDay.get(button)?.();
      };
      scroller.addEventListener("pointerup", finishPointer);
      scroller.addEventListener("pointercancel", (event) => finishPointer(event, true));
    }
    const revealActiveButton = (): void => {
      if (!activeButton) {
        return;
      }
      const padding = 8;
      const visibleLeft = scroller.scrollLeft;
      const visibleRight = visibleLeft + scroller.clientWidth;
      const buttonLeft = activeButton.offsetLeft;
      const buttonRight = buttonLeft + activeButton.offsetWidth;
      if (buttonLeft < visibleLeft + padding) {
        scroller.scrollLeft = Math.max(0, buttonLeft - padding);
      } else if (buttonRight > visibleRight - padding) {
        scroller.scrollLeft = buttonRight - scroller.clientWidth + padding;
      }
      this.timeNavScrollLeft[sectionId] = scroller.scrollLeft;
    };
    scroller.scrollLeft = this.timeNavScrollLeft[sectionId];
    revealActiveButton();
    updateEdges();
    window.requestAnimationFrame(() => {
      scroller.scrollLeft = this.timeNavScrollLeft[sectionId];
      revealActiveButton();
      updateEdges();
    });
  }

  private revealSelectedTimeChips(): void {
    const shells = Array.from(
      this.containerEl.querySelectorAll(".task-flow-time-nav")
    ) as HTMLElement[];
    for (const shell of shells) {
      const scroller = shell.querySelector(".task-flow-inline-selector") as HTMLElement | null;
      if (!scroller) continue;
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      shell.toggleClass("can-scroll-left", scroller.scrollLeft > 2);
      shell.toggleClass("can-scroll-right", scroller.scrollLeft < maxScroll - 2);
    }
  }

  private openWeekTaskDatePicker(task: DemoTask): void {
    const activeFile = this.requireTargetMonthlyFile();
    const month = activeFile ? parseMonthlyFileName(activeFile.name) : null;
    const selectedWeek = month
      ? buildMonthWeeks(month).find((week) => week.key === this.selectedWeekKey)
      : null;
    if (!activeFile || !selectedWeek) {
      new Notice("未找到当前周");
      return;
    }

    new DateChoiceModal(
      this.app,
      "添加到指定日期",
      selectedWeek.days.map((day) => ({
        key: day.key,
        label: day.shortLabel
      })),
      async (dayKey) => {
        await addWeekTaskToDay(
          this.store,
          this.app.vault,
          activeFile,
          task.id,
          dayKey
        );
        this.selectedDayKey = dayKey;
        await this.render();
      }
    ).open();
  }

  private async joinDayTaskToWeek(task: DemoTask): Promise<void> {
    const file = this.requireTargetMonthlyFile();
    if (!file || !this.selectedWeekKey) {
      new Notice("未找到当前周");
      return;
    }
    try {
      await addDayTaskToWeek(this.store, this.app.vault, file, task.id);
      new Notice("已添加到周任务");
    } catch (error) {
      console.error("Task Flow: failed to add day task to week", error);
      new Notice(error instanceof Error ? error.message : "添加到周任务失败");
    }
  }

  private continueDayTask(task: DemoTask): void {
    const activeFile = this.requireTargetMonthlyFile();
    const monthMeta = activeFile ? parseMonthlyFileName(activeFile.name) : null;
    const selectedWeek = monthMeta
      ? buildMonthWeeks(monthMeta).find((week) => week.key === this.selectedWeekKey)
      : null;
    if (!activeFile || !selectedWeek) {
      new Notice("未找到当前周");
      return;
    }

    new DateChoiceModal(
      this.app,
      "延续到指定日期",
      selectedWeek.days.map((day) => ({
        key: day.key,
        label: day.shortLabel
      })),
      async (dayKey) => {
        const alreadyExists = await taskHasContinuedInstance(
          this.store, activeFile, task.id, dayKey
        );
        if (alreadyExists) {
          new Notice("该任务已存在于指定日期");
        } else {
          await continueDayTask(this.store, this.app.vault, activeFile, task.id, dayKey);
        }
        this.selectedDayKey = dayKey;
        await this.render();
      }
    ).open();
  }

  private moveDayTaskToDatePicker(task: DemoTask): void {
    const ctx = this.getSelectedWeekContext();
    if (!ctx) return;
    const taskId = task.id;
    new DateChoiceModal(
      this.app,
      "移动到指定日期",
      ctx.days,
      async (dayKey) => {
        try {
          await moveDayTask(this.store, this.app.vault, ctx.file, taskId, dayKey);
          this.selectedDayKey = dayKey;
          await this.render();
        } catch (error) {
          console.error("Task Flow: move day task failed", error);
          new Notice(error instanceof Error ? error.message : "移动失败");
        }
      }
    ).open();
  }

  private openMoveProjectionChildrenPicker(parentTaskId: string, currentDayKey: string): void {
    const ctx = this.getSelectedWeekContext();
    if (!ctx) return;
    new DateChoiceModal(
      this.app,
      "移动子任务到指定日期",
      ctx.days,
      async (dayKey) => {
        try {
          await moveProjectionChildren(this.store, this.app.vault, ctx.file, parentTaskId, currentDayKey, dayKey);
          this.selectedDayKey = dayKey;
          await this.render();
        } catch (error) {
          console.error("Task Flow: move projection children failed", error);
          new Notice(error instanceof Error ? error.message : "移动失败");
        }
      }
    ).open();
  }

  private async joinBatchDayTasksToWeek(): Promise<void> {
    const file = this.requireTargetMonthlyFile();
    const selectedTaskIds = [...(this.multiSelect?.selectedKeys ?? [])];
    if (!file || !this.selectedWeekKey || selectedTaskIds.length === 0) {
      new Notice("请先选择日任务");
      return;
    }
    try {
      await addDayTasksToWeek(
        this.store,
        this.app.vault,
        file,
        selectedTaskIds,
      );
      this.multiSelect = null;
      new Notice("已添加到周任务");
    } catch (error) {
      console.error("Task Flow: failed to add day tasks to week", error);
      new Notice(error instanceof Error ? error.message : "添加到周任务失败");
    }
  }

  private openBatchWeekDatePicker(): void {
    const activeFile = this.requireTargetMonthlyFile();
    const month = activeFile ? parseMonthlyFileName(activeFile.name) : null;
    const selectedWeek = month
      ? buildMonthWeeks(month).find((week) => week.key === this.selectedWeekKey)
      : null;
    const selectedTaskIds = [...(this.multiSelect?.selectedKeys ?? [])];
    if (!activeFile || !selectedWeek || selectedTaskIds.length === 0) {
      new Notice("请先选择周任务");
      return;
    }

    new DateChoiceModal(
      this.app,
      "批量添加到指定日期",
      selectedWeek.days.map((day) => ({
        key: day.key,
        label: day.shortLabel
      })),
      async (dayKey) => {
        await addWeekTasksToDay(
          this.store,
          this.app.vault,
          activeFile,
          selectedTaskIds,
          dayKey,
        );
        this.selectedDayKey = dayKey;
        this.multiSelect = null;
        await this.render();
      }
    ).open();
  }

  private getSelectedWeekContext(): {
    file: TFile;
    days: Array<{ key: string; label: string }>;
  } | null {
    const file = this.requireTargetMonthlyFile();
    const month = file ? parseMonthlyFileName(file.name) : null;
    const selectedWeek = month
      ? buildMonthWeeks(month).find((week) => week.key === this.selectedWeekKey)
      : null;
    if (!file || !selectedWeek) {
      new Notice("未找到当前周");
      return null;
    }
    return {
      file,
      days: selectedWeek.days.map((day) => ({
        key: day.key,
        label: day.shortLabel
      }))
    };
  }

  private requireTargetMonthlyFile(): TFile | null {
    const { month } = this.resolveViewTime();
    const file = this.findMonthlyFile(month.year, month.month);
    if (!file) {
      new Notice(`\u672a\u627e\u5230 ${formatMonthTitle(month)}.md\uff0c\u8bf7\u5148\u521b\u5efa\u5bf9\u5e94\u6708\u6587\u6863`);
      return null;
    }
    return file;
  }

  private async canCreateInArea(area: TaskArea, areaKey: string): Promise<boolean> {
    const file = this.requireTargetMonthlyFile();
    if (!file) return false;

    const content = await this.getCurrentDocumentContent(file);
    const exists = area === "week"
      ? hasWeekBlock(content, areaKey)
      : hasDayBlock(content, areaKey);
    if (!exists) {
      this.showMissingAreaModal(file, area);
    }
    return exists;
  }

  private async canCreateChildUnder(parentId: string): Promise<boolean> {
    const file = this.requireTargetMonthlyFile();
    if (!file) return false;
    const month = await this.store.getMonth(file);
    const parent = month?.tasks[parentId];
    if (!parent) {
      new Notice("\u672a\u627e\u5230\u8981\u6dfb\u52a0\u5b50\u4efb\u52a1\u7684\u4efb\u52a1");
      return false;
    }

    const content = await this.getCurrentDocumentContent(file);
    if (parent.area === "week" && !hasWeekBlock(content, parent.areaKey)) {
      this.showMissingAreaModal(file, "week");
      return false;
    }
    if (parent.area === "day" && !hasDayBlock(content, parent.areaKey)) {
      this.showMissingAreaModal(file, "day");
      return false;
    }
    if (parent.area === "day" && parent.sourceWeekTaskId) {
      const weekSource = month?.tasks[parent.sourceWeekTaskId];
      if (weekSource && !hasWeekBlock(content, weekSource.areaKey)) {
        this.showMissingAreaModal(file, "week");
        return false;
      }
    }
    return true;
  }

  private showMissingAreaModal(file: TFile, area: TaskArea): void {
    const message = area === "week"
      ? "\u8bf7\u5148\u5728\u6708\u6587\u6863\u4e2d\u521b\u5efa\u5bf9\u5e94\u7684\u5468\u533a\u57df"
      : "\u8bf7\u5148\u5728\u6708\u6587\u6863\u4e2d\u521b\u5efa\u5bf9\u5e94\u7684\u65e5\u671f\u533a\u57df";
    new MissingTargetAreaModal(
      this.app,
      message,
      async () => this.openMonthlyFileInNewTab(file)
    ).open();
  }

  private async getCurrentDocumentContent(file: TFile): Promise<string> {
    const editor = this.findOpenMarkdownEditor(file);
    return editor
      ? editor.getValue()
      : await this.app.vault.read(file);
  }

  private findOpenMarkdownEditor(file: TFile): Editor | undefined {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((view): view is MarkdownView =>
        view instanceof MarkdownView && view.file?.path === file.path
      )
      ?.editor;
  }

  private async openMonthlyFileInNewTab(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private renderEmptyState(root: Element): void {
    root.createDiv({ cls: "task-flow-title", text: "Task Flow 2.0" });
    root.createDiv({ cls: "task-flow-muted", text: "请打开一个月文档。" });
  }

  private async confirmAndDelete(task: DemoTask): Promise<void> {
    const file = this.requireTargetMonthlyFile();
    if (!file) {
      return;
    }

    // Parent-context: delete only children in current day, not the parent itself
    if (task.isParentContext && task.actionTaskId && this.selectedDayKey) {
      const config: DeleteConfirmConfig = {
        title: "确认删除",
        message: `将删除「${task.name}」在当前日期的所有子任务，不影响其他日期的任务。此操作不可撤销。`,
        isSevere: false,
        onConfirm: async () => {
          try {
            await this.confirmProjectionTasklogDelete(
              file,
              task.actionTaskId!,
              this.selectedDayKey!,
              async () => {
                await deleteProjectionDescendants(this.store, this.app.vault, file, task.actionTaskId!, this.selectedDayKey!);
                new Notice("已删除");
              },
            );
          } catch (error) {
            console.error("Task Flow: projection delete failed", error);
            new Notice(error instanceof Error ? error.message : "删除失败");
          }
        }
      };
      new DeleteConfirmModal(this.app, config).open();
      return;
    }

    const month = await this.store.getMonth(file);
    if (!month) {
      new Notice("数据加载失败，请刷新后重试");
      return;
    }

    const taskId = task.id;
    if (!month.tasks[taskId]) {
      new Notice("任务不存在或已被删除");
      return;
    }

    const preview = getDeletionPreview(month, taskId);
    const config = buildDeleteConfirmConfig(preview);
    config.onConfirm = async () => {
      try {
        await this.confirmTasklogDelete(file, [taskId], async () => {
          await deleteTask(this.store, this.app.vault, file, taskId);
          new Notice("已删除");
        });
      } catch (error) {
        console.error("Task Flow: delete failed", error);
        new Notice(error instanceof Error ? error.message : "删除失败");
      }
    };
    new DeleteConfirmModal(this.app, config).open();
  }

  private async confirmAndBatchDelete(): Promise<void> {
    const file = this.requireTargetMonthlyFile();
    if (!file) {
      return;
    }
    const selectedTaskIds = [...(this.multiSelect?.selectedKeys ?? [])];
    if (selectedTaskIds.length === 0) {
      return;
    }

    const month = await this.store.getMonth(file);
    if (!month) {
      new Notice("数据加载失败，请刷新后重试");
      return;
    }

    // Filter out invalid IDs
    const validIds = selectedTaskIds.filter((id) => month.tasks[id]);
    if (validIds.length === 0) {
      new Notice("所选任务均已不存在");
      return;
    }

    const preview = getBatchDeletionPreview(month, validIds);

    let message = `已选择 ${validIds.length} 项任务，将一并删除。`;
    if (preview.childNames.length > 0 || preview.dayInstances.length > 0) {
      const parts: string[] = [];
      if (preview.childNames.length > 0) {
        parts.push(`${preview.childNames.length} 个关联子任务`);
      }
      if (preview.dayInstances.length > 0) {
        const dates = preview.dayInstances.map((d) => d.date).join("、");
        parts.push(`${preview.dayInstances.length} 个日任务实例（${dates}）`);
      }
      message = `已选择 ${validIds.length} 项任务（含 ${parts.join("、")}），将一并删除。`;
    }
    message += " 此操作不可撤销。";

    const config: DeleteConfirmConfig = {
      title: "确认批量删除",
      message,
      isSevere: preview.level === "cross_area",
      onConfirm: async () => {
        try {
          await this.confirmTasklogDelete(file, validIds, async () => {
            await deleteTasks(this.store, this.app.vault, file, validIds);
            this.multiSelect = null;
            new Notice("已删除");
          });
        } catch (error) {
          console.error("Task Flow: batch delete failed", error);
          new Notice(error instanceof Error ? error.message : "删除失败");
        }
      }
    };

    new DeleteConfirmModal(this.app, config).open();
  }

  private async confirmTasklogDelete(
    file: TFile,
    taskIds: string[],
    onDelete: () => Promise<void>,
  ): Promise<void> {
    const month = await this.store.getMonth(file);
    if (!month) return;
    const content = await this.app.vault.read(file);
    const conflicts = getDeletionTasklogIds(month, taskIds, content);
    await this.resolveTasklogDeleteConflicts(file, conflicts, onDelete);
  }

  private async confirmProjectionTasklogDelete(
    file: TFile,
    parentTaskId: string,
    dayKey: string,
    onDelete: () => Promise<void>,
  ): Promise<void> {
    const month = await this.store.getMonth(file);
    if (!month) return;
    const content = await this.app.vault.read(file);
    const conflicts = getProjectionDeletionTasklogIds(
      month,
      parentTaskId,
      dayKey,
      content,
    );
    await this.resolveTasklogDeleteConflicts(file, conflicts, onDelete);
  }

  private async resolveTasklogDeleteConflicts(
    file: TFile,
    conflicts: string[],
    onDelete: () => Promise<void>,
  ): Promise<void> {
    if (conflicts.length === 0) {
      await onDelete();
      return;
    }
    new TasklogDeleteConflictModal(this.app, conflicts, async () => {
      let latest = await this.app.vault.read(file);
      for (const id of conflicts) latest = orphanTasklog(latest, id);
      await this.app.vault.modify(file, latest);
      await onDelete();
    }).open();
  }

  private async copyTasklogTemplate(file: TFile, task: DemoTask): Promise<void> {
    const month = await this.store.getMonth(file);
    if (!month) return;

    const taskRecord = month.tasks[task.actionTaskId ?? task.id];
    if (!taskRecord) return;

    const childName = taskRecord.name;
    let parentName = "";
    if (taskRecord.parentId) {
      const parent = month.tasks[taskRecord.parentId];
      if (parent) parentName = ` / ${parent.name}`;
    }

    const template = `### ${childName}${parentName}\ntasklog:: ${taskRecord.id}\n***\n`;
    await navigator.clipboard.writeText(template);
    new Notice("工作记录模板已复制到剪贴板");
  }

  private debounceTasklogScan(file: TFile, editor?: Editor): void {
    if (this.tasklogDebounceTimer) {
      clearTimeout(this.tasklogDebounceTimer);
    }
    this.tasklogDebounceTimer = setTimeout(() => {
      this.tasklogDebounceTimer = null;
      void this.handleTasklogScan(file, editor);
    }, 200);
  }

  private async handleTasklogScan(file: TFile, editor?: Editor): Promise<void> {
    try {
      await runStatusDocumentOperation(file, async () => {
      const content = editor?.getValue() ?? await this.app.vault.read(file);
      const currentSet = findTasklog(content);

      if (!this.lastTasklogSet) {
        this.lastTasklogSet = currentSet;
        return;
      }

      const prevSet = this.lastTasklogSet;
      this.lastTasklogSet = currentSet;
      const monthBefore = await this.store.getMonth(file);
      const notifiedGroups = new Set<string>();
      const statusChanges: Array<{ taskId: string; newStatus: TaskStatus }> = [];

      // Check for added tasklogs
      for (const id of currentSet) {
        if (!prevSet.has(id)) {
          statusChanges.push({ taskId: id, newStatus: "doing" });
        }
      }

      // Check for removed tasklogs
      for (const id of prevSet) {
        if (!currentSet.has(id)) {
          statusChanges.push({ taskId: id, newStatus: "todo" });

          if (monthBefore) {
            const removedTask = monthBefore.tasks[id];
            if (removedTask?.area === "day" && removedTask.childIds.length === 0) {
              const groupKey = taskIdentityKey(removedTask);
              const group = Object.values(monthBefore.tasks).filter((task) => (
                task.area === "day"
                && task.childIds.length === 0
                && taskIdentityKey(task) === groupKey
              ));
              const hasRemainingTasklog = group.some((task) => currentSet.has(task.id));
              if (
                group.length > 1
                && !hasRemainingTasklog
                && !notifiedGroups.has(groupKey)
              ) {
                notifiedGroups.add(groupKey);
                const dates = [...new Set(group.map((task) => formatDayKey(task.areaKey)))]
                  .join("，");
                new Notice(
                  `任务 ${removedTask.name} 的所有工作记录均已删除，跨日期实例（${dates}）已保留并全部恢复为未开始`,
                );
              }
            }
          }
        }
      }

      const newContent = await applyDayTaskStatusChanges(
        this.store,
        file,
        statusChanges,
        content,
      );
      if (newContent !== content) {
        if (editor) {
          applyEditorLineChanges(editor, content, newContent);
        } else {
          await this.app.vault.modify(file, newContent);
        }
      }
      });
    } catch {
      // Silently skip scan errors
    }
  }

}

function applyEditorLineChanges(
  editor: Editor,
  oldContent: string,
  newContent: string,
): void {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  if (oldLines.length !== newLines.length) {
    editor.setValue(newContent);
    return;
  }

  for (let line = oldLines.length - 1; line >= 0; line -= 1) {
    if (oldLines[line] === newLines[line]) continue;
    editor.replaceRange(
      newLines[line],
      { line, ch: 0 },
      { line, ch: oldLines[line].length },
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatchingLine(content: string, pattern: RegExp): number | null {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index;
  }
  return null;
}

function isTaskRowControl(target: HTMLElement): boolean {
  return Boolean(target.closest([
    ".task-flow-status-dot",
    ".task-flow-task-actions",
    ".task-flow-drag-handle",
    ".task-flow-task-checkbox",
    ".task-flow-inline-input",
    "button",
    "input",
    "textarea"
  ].join(",")));
}

function bindPrimaryAction(
  element: HTMLElement,
  action: (event: PointerEvent) => void | Promise<void>,
): void {
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    void action(event);
  });
}

function bindMobileTap(
  element: HTMLElement,
  action: (event: MouseEvent) => void | Promise<void>,
): void {
  element.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void action(event);
  });
}

// Synthetic rows (parent-context, source-group, date-group) don't
// correspond to real tasks in dayTaskIds/weekTaskIds.  Exclude them from
// drag-sibling calculations so the drop indicator and reorder index match
// the actual data arrays.
function isRealTaskRow(row: HTMLElement): boolean {
  const id = row.dataset.taskId ?? "";
  return !id.startsWith("parent-context:")
    && !id.startsWith("source-group:")
    && !id.startsWith("date-group:")
    && !id.startsWith("prior-parent:");
}

/** Resolve target index in the data array for reorderTask.
 *  Root level (no parentId): operates on weekTaskIds/dayTaskIds (TaskOrderItem[]).
 *  Child level (has parentId): operates on parent.childIds (string[]). */
function resolveDataIndex(
  month: MonthTaskData,
  targetTask: TaskRecord,
  draggedTask: TaskRecord,
  insertBefore: boolean
): number {
  if (targetTask.parentId) {
    const parent = month.tasks[targetTask.parentId];
    if (!parent) return -1;
    const orderArray = parent.childIds;
    const targetPos = orderArray.indexOf(targetTask.id);
    if (targetPos === -1) return -1;
    const draggedPos = orderArray.indexOf(draggedTask.id);
    let index = insertBefore ? targetPos : targetPos + 1;
    if (draggedPos !== -1 && draggedPos < index) {
      index -= 1;
    }
    return index;
  }

  const areaIds = targetTask.area === "week"
    ? getWeekTaskIds(month, targetTask.areaKey)
    : getDayTaskIds(month, targetTask.areaKey);
  const targetFound = findOrderItem(areaIds, targetTask.id);
  if (!targetFound) return -1;
  const draggedFound = findOrderItem(areaIds, draggedTask.id);
  let index = insertBefore ? targetFound.index : targetFound.index + 1;
  if (draggedFound && draggedFound.index < index) {
    index -= 1;
  }
  return index;
}

/** Walk forward from a parent row to find the bottom of its last child.
 *  This makes "insert after" indicator sit below the entire card, not
 *  just the parent row. */
function findCardBottom(startRow: HTMLElement, depth: number): number {
  let bottom = startRow.getBoundingClientRect().bottom;
  let next = startRow.nextElementSibling as HTMLElement | null;
  while (next) {
    const nextDepth = parseInt(next.dataset.depth ?? "0", 10);
    if (nextDepth <= depth) break;
    bottom = next.getBoundingClientRect().bottom;
    next = next.nextElementSibling as HTMLElement | null;
  }
  return bottom;
}

function formatDayKey(dayKey: string): string {
  const match = /^\d{4}\.(\d{1,2})\.(\d{1,2})$/.exec(dayKey);
  return match ? `${match[1]}.${match[2]}` : dayKey;
}

function monthFromWeekKey(weekKey: string): MonthlyFile {
  const [startDayKey] = weekKey.split("-");
  return monthFromDayKey(startDayKey);
}

function monthFromDayKey(dayKey: string): MonthlyFile {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(dayKey);
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2])
    };
  }
  const today = new Date();
  return {
    year: today.getFullYear(),
    month: today.getMonth() + 1
  };
}

function formatMonthTitle(month: MonthlyFile): string {
  return `${month.year}.${month.month}`;
}

function isSameMonth(a: MonthlyFile, b: MonthlyFile): boolean {
  return a.year === b.year && a.month === b.month;
}

function shiftMonth(month: MonthlyFile, offset: number): MonthlyFile {
  const date = new Date(month.year, month.month - 1 + offset, 1);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1
  };
}

function getYearPageStart(year: number): number {
  return Math.floor(year / 12) * 12;
}

function formatDayTitleLabel(date: Date): string {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${date.getMonth() + 1}.${date.getDate()} ${weekdays[date.getDay()]}`;
}

function getDayOperationAvailability(task: DemoTask): "move" | "continue" | "none" {
  const statuses = task.children && task.children.length > 0
    ? task.children.map((child) => child.status)
    : [task.status];
  if (statuses.every((status) => status === "todo")) return "move";
  if (statuses.every((status) => status === "doing")) return "continue";
  return "none";
}

interface TagGroupResult {
  untagged: DemoTask[];
  primaryGroups: PrimaryTagGroup[];
}

interface PrimaryTagGroup {
  primary: string;
  plainTasks: DemoTask[];
  subgroups: SecondaryTagGroup[];
}

interface SecondaryTagGroup {
  secondary: string;
  tasks: DemoTask[];
}

function getTagSortGroupsForOrder(
  orderItems: TaskOrderItem[],
  tasks: Record<string, TaskRecord>
): TagSortGroup[] {
  const groupByPrimary = new Map<string, {
    secondaryCounts: Map<string, number>;
    secondaries: string[];
  }>();

  for (const item of orderItems) {
    const task = tasks[typeof item === "string" ? item : item.id];
    if (!task) continue;
    const tags = task.tags ?? parseStoredTaskName(task.name).tags;
    if (!tags.primary) continue;
    let group = groupByPrimary.get(tags.primary);
    if (!group) {
      group = { secondaryCounts: new Map(), secondaries: [] };
      groupByPrimary.set(tags.primary, group);
    }
    if (tags.secondary) {
      group.secondaryCounts.set(tags.secondary, (group.secondaryCounts.get(tags.secondary) ?? 0) + 1);
      if (!group.secondaries.includes(tags.secondary)) {
        group.secondaries.push(tags.secondary);
      }
    }
  }

  return [...groupByPrimary.entries()].map(([primary, group]) => ({
    primary,
    secondaries: group.secondaries.filter((secondary) => (group.secondaryCounts.get(secondary) ?? 0) >= 2)
  }));
}

function buildTagGroups(tasks: DemoTask[]): TagGroupResult {
  const untagged: DemoTask[] = [];
  const primaryGroups: PrimaryTagGroup[] = [];
  const primaryByTag = new Map<string, {
    tasks: DemoTask[];
    secondaryCounts: Map<string, number>;
  }>();

  for (const task of tasks) {
    const primary = task.tags?.primary ?? null;
    if (!primary) {
      untagged.push(task);
      continue;
    }
    let group = primaryByTag.get(primary);
    if (!group) {
      group = { tasks: [], secondaryCounts: new Map() };
      primaryByTag.set(primary, group);
    }
    group.tasks.push(task);
    const secondary = task.tags?.secondary ?? null;
    if (secondary) {
      group.secondaryCounts.set(secondary, (group.secondaryCounts.get(secondary) ?? 0) + 1);
    }
  }

  for (const [primary, source] of primaryByTag.entries()) {
    const plainTasks: DemoTask[] = [];
    const subgroups: SecondaryTagGroup[] = [];
    const subgroupByTag = new Map<string, SecondaryTagGroup>();

    for (const task of source.tasks) {
      const secondary = task.tags?.secondary ?? null;
      if (!secondary || (source.secondaryCounts.get(secondary) ?? 0) < 2) {
        plainTasks.push(secondary ? { ...task, inlineTag: secondary } : task);
        continue;
      }
      let subgroup = subgroupByTag.get(secondary);
      if (!subgroup) {
        subgroup = { secondary, tasks: [] };
        subgroupByTag.set(secondary, subgroup);
        subgroups.push(subgroup);
      }
      subgroup.tasks.push(task);
    }

    primaryGroups.push({ primary, plainTasks, subgroups });
  }

  return { untagged, primaryGroups };
}


class DemoModal extends Modal {
  constructor(
    app: ItemView["app"],
    private readonly title: string,
    private readonly message: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createDiv({ cls: "task-flow-modal-message", text: this.message });
    const closeButton = this.contentEl.createEl("button", { text: "关闭" });
    closeButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class EmptyTaskNameModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly actions: {
      onContinue: () => void;
      onCancel: () => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("任务名称不能为空");
    this.contentEl.createDiv({
      cls: "task-flow-modal-message",
      text: "请输入任务名称后再创建。"
    });
    const actions = this.contentEl.createDiv({ cls: "task-flow-modal-actions" });
    const continueButton = actions.createEl("button", { text: "继续编辑" });
    continueButton.addEventListener("click", () => {
      this.resolved = true;
      this.close();
      this.actions.onContinue();
    });
    const cancelButton = actions.createEl("button", { text: "取消创建" });
    cancelButton.addEventListener("click", () => {
      this.resolved = true;
      this.close();
      this.actions.onCancel();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.actions.onContinue();
    }
  }
}

class EditTagModal extends Modal {
  private input: HTMLInputElement | null = null;
  private submitting = false;

  constructor(
    app: App,
    private readonly initialValue: string,
    private readonly onSubmit: (tagName: string) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("编辑标签");
    const input = this.contentEl.createEl("input", {
      cls: "task-flow-tag-edit-input",
      attr: {
        type: "text",
        placeholder: "#标签"
      }
    });
    input.value = this.initialValue;
    this.input = input;
    const actions = this.contentEl.createDiv({ cls: "task-flow-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
    const confirmButton = actions.createEl("button", { text: "确认" });
    confirmButton.addEventListener("click", () => {
      void this.submit();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void this.submit();
      }
    });
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  onClose(): void {
    this.input = null;
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.input) return;
    const nextTag = this.input.value.trim();
    this.submitting = true;
    this.input.disabled = true;
    try {
      await this.onSubmit(nextTag);
      this.close();
    } catch (error) {
      this.submitting = false;
      this.input.disabled = false;
      console.error("Task Flow: failed to edit tag", error);
      new Notice(error instanceof Error ? error.message : "编辑标签失败");
      window.setTimeout(() => this.input?.focus({ preventScroll: true }));
    }
  }
}

class TagSortModal extends Modal {
  private primaryList: HTMLElement | null = null;
  private sortIndicator: HTMLElement | null = null;
  private saving = false;

  constructor(
    app: App,
    private readonly initialGroups: TagSortGroup[],
    private readonly onSave: (groups: TagSortGroup[]) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("标签排序");
    const list = this.contentEl.createDiv({ cls: "task-flow-tag-sort-list" });
    this.primaryList = list;
    for (const group of this.initialGroups) {
      this.renderPrimaryBlock(list, group);
    }
    const actions = this.contentEl.createDiv({ cls: "task-flow-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
    const saveButton = actions.createEl("button", { text: "保存" });
    saveButton.addEventListener("click", () => {
      void this.save();
    });
  }

  onClose(): void {
    this.sortIndicator?.remove();
    this.sortIndicator = null;
    this.primaryList = null;
    this.contentEl.empty();
  }

  private renderPrimaryBlock(parent: HTMLElement, group: TagSortGroup): void {
    const block = parent.createDiv({
      cls: "task-flow-tag-sort-primary",
      attr: { "data-primary": group.primary }
    });
    const row = block.createDiv({
      cls: "task-flow-tag-sort-row is-primary",
      attr: { "data-primary": group.primary }
    });
    const handle = row.createSpan({ cls: "task-flow-tag-sort-handle" });
    setIcon(handle, "grip-vertical");
    row.createSpan({ cls: "task-flow-tag-pill", text: group.primary });
    this.bindSortableDrag(row, block, parent);

    if (group.secondaries.length > 0) {
      const secondaryList = block.createDiv({ cls: "task-flow-tag-sort-secondary-list" });
      for (const secondary of group.secondaries) {
        const secondaryRow = secondaryList.createDiv({
          cls: "task-flow-tag-sort-row is-secondary",
          attr: { "data-secondary": secondary }
        });
        const secondaryHandle = secondaryRow.createSpan({ cls: "task-flow-tag-sort-handle" });
        setIcon(secondaryHandle, "grip-vertical");
        secondaryRow.createSpan({ cls: "task-flow-tag-node-dot" });
        secondaryRow.createSpan({ cls: "task-flow-tag-pill", text: secondary });
        this.bindSortableDrag(secondaryRow, secondaryRow, secondaryList);
      }
    }
  }

  private bindSortableDrag(trigger: HTMLElement, item: HTMLElement, container: HTMLElement): void {
    trigger.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      const startY = event.clientY;
      let dragging = false;
      let targetBefore: HTMLElement | null = null;
      let shouldAppend = false;
      const indicator = this.getSortIndicator();
      try {
        trigger.setPointerCapture(pointerId);
      } catch {
        // Window-level listeners below still keep the drag alive.
      }

      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        if (!dragging && Math.abs(moveEvent.clientY - startY) < 4) return;
        dragging = true;
        item.addClass("is-dragging");
        const siblings = Array.from(container.children)
          .filter((child): child is HTMLElement => child instanceof HTMLElement && child !== item);
        let foundTarget = false;
        let targetRect: DOMRect | null = null;
        let beforeTarget = true;
        targetBefore = null;
        shouldAppend = false;
        for (const sibling of siblings) {
          const rect = sibling.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (moveEvent.clientY < midY) {
            targetRect = rect;
            beforeTarget = true;
            targetBefore = sibling;
            foundTarget = true;
            break;
          }
        }
        if (!foundTarget) {
          const last = siblings[siblings.length - 1] ?? item;
          targetRect = last.getBoundingClientRect();
          beforeTarget = false;
          shouldAppend = true;
        }
        if (targetRect) {
          indicator.style.display = "block";
          indicator.style.left = `${targetRect.left}px`;
          indicator.style.top = `${(beforeTarget ? targetRect.top : targetRect.bottom) - 1}px`;
          indicator.style.width = `${targetRect.width}px`;
        }
      };

      const finish = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId !== pointerId) return;
        upEvent.preventDefault();
        if (dragging) {
          if (shouldAppend) {
            container.appendChild(item);
          } else if (targetBefore) {
            container.insertBefore(item, targetBefore);
          }
        }
        cleanup();
      };
      const cleanup = (): void => {
        item.removeClass("is-dragging");
        indicator.style.display = "none";
        try {
          trigger.releasePointerCapture(pointerId);
        } catch {
          // The pointer may already have been released by the platform.
        }
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", finish, true);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", finish, true);
    });
  }

  private getSortIndicator(): HTMLElement {
    if (!this.sortIndicator) {
      this.sortIndicator = document.createElement("div");
      this.sortIndicator.className = "task-flow-tag-sort-indicator";
      document.body.appendChild(this.sortIndicator);
    }
    return this.sortIndicator;
  }

  private readGroups(): TagSortGroup[] {
    if (!this.primaryList) return [];
    return Array.from(this.primaryList.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .map((block) => ({
        primary: block.dataset.primary ?? "",
        secondaries: Array.from(block.querySelectorAll<HTMLElement>(".task-flow-tag-sort-row.is-secondary"))
          .map((row) => row.dataset.secondary ?? "")
          .filter(Boolean)
      }))
      .filter((group) => group.primary.length > 0);
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      await this.onSave(this.readGroups());
      this.close();
    } catch (error) {
      this.saving = false;
      console.error("Task Flow: failed to sort tags", error);
      new Notice(error instanceof Error ? error.message : "标签排序失败");
    }
  }
}

class MobileTaskCreateModal extends Modal {
  private committed = false;
  private nativeKeyboardHeight = 0;
  private readonly nativeKeyboardListeners: Array<{ remove: () => Promise<void> }> = [];
  private input: HTMLTextAreaElement | null = null;
  private inputShell: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly onCommit: (name: string) => Promise<void>,
    private readonly onDismiss: () => void,
    private readonly options: {
      initialValue?: string;
      placeholder?: string;
      failureMessage?: string;
    } = {}
  ) {
    super(app);
  }

  onOpen(): void {
    this.containerEl.addClass("task-flow-create-modal-container");
    this.modalEl.addClass("task-flow-create-modal");
    this.titleEl.empty();
    this.contentEl.empty();
    const page = this.contentEl.createDiv({ cls: "task-flow-create-page" });
    const scrim = page.createDiv({ cls: "task-flow-create-page-scrim" });
    const inputShell = page.createDiv({ cls: "task-flow-create-page-input-shell" });
    const input = inputShell.createEl("textarea", {
      cls: "task-flow-inline-input",
      attr: {
        rows: "1",
        placeholder: this.options.placeholder ?? "输入任务名称"
      }
    });
    input.value = this.options.initialValue ?? "";
    this.input = input;
    this.inputShell = inputShell;
    scrim.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (input.value.trim().length > 0) {
        void this.commit();
      } else {
        this.close();
      }
    });

    const positionInput = (): void => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 104)}px`;
      input.style.overflowY = input.scrollHeight > 104 ? "auto" : "hidden";
      window.requestAnimationFrame(() => this.positionModal());
    };
    input.addEventListener("input", positionInput);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void this.commit();
      }
    });

    const nativeKeyboard = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            Keyboard?: {
              addListener?: (
                eventName: "keyboardWillShow" | "keyboardDidShow" | "keyboardWillHide" | "keyboardDidHide",
                listener: (info: { keyboardHeight?: number }) => void
              ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
            };
          };
        };
      }
    ).Capacitor?.Plugins?.Keyboard;
    const listen = (
      eventName: "keyboardWillShow" | "keyboardDidShow" | "keyboardWillHide" | "keyboardDidHide",
      listener: (info: { keyboardHeight?: number }) => void
    ): void => {
      const result = nativeKeyboard?.addListener?.(eventName, listener);
      if (!result) return;
      void Promise.resolve(result).then((handle) => {
        if (this.modalEl.isConnected) {
          this.nativeKeyboardListeners.push(handle);
        } else {
          void handle.remove();
        }
      });
    };
    const showKeyboard = (info: { keyboardHeight?: number }): void => {
      this.nativeKeyboardHeight = Math.max(0, info.keyboardHeight ?? 0);
      this.positionModal();
    };
    const hideKeyboard = (): void => {
      this.nativeKeyboardHeight = 0;
      this.positionModal();
    };
    listen("keyboardWillShow", showKeyboard);
    listen("keyboardDidShow", showKeyboard);
    listen("keyboardWillHide", hideKeyboard);
    listen("keyboardDidHide", hideKeyboard);
    window.addEventListener("resize", this.positionModal);

    window.requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      positionInput();
    });
  }
  onClose(): void {
    window.removeEventListener("resize", this.positionModal);
    for (const listener of this.nativeKeyboardListeners.splice(0)) {
      void listener.remove();
    }
    this.input = null;
    this.inputShell = null;
    this.contentEl.empty();
    this.onDismiss();
  }
  private readonly positionModal = (): void => {
    if (!this.input?.isConnected || !this.inputShell?.isConnected) return;
    const visibleBottom = this.nativeKeyboardHeight > 0
      ? window.innerHeight - this.nativeKeyboardHeight
      : window.innerHeight;
    const shellHeight = this.inputShell.offsetHeight;
    this.inputShell.style.top = `${Math.round(Math.max(
      12,
      visibleBottom - shellHeight - 12
    ))}px`;
  };
  private async commit(): Promise<void> {
    if (this.committed || !this.input) return;
    const name = this.input.value.trim();
    if (!name) {
      new Notice("任务名称不能为空");
      this.input.focus({ preventScroll: true });
      return;
    }
    this.committed = true;
    this.input.disabled = true;
    try {
      await this.onCommit(name);
      this.close();
    } catch (error) {
      this.committed = false;
      this.input.disabled = false;
      console.error("Task Flow: failed to commit task input", error);
      new Notice(error instanceof Error ? error.message : this.options.failureMessage ?? "创建任务失败");
      window.setTimeout(() => this.input?.focus({ preventScroll: true }));
    }
  }
}
class MissingTargetAreaModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly onOpenTarget: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("\u7f3a\u5c11\u76ee\u6807\u533a\u57df");
    this.contentEl.createDiv({
      cls: "task-flow-modal-message",
      text: this.message
    });
    const actions = this.contentEl.createDiv({ cls: "task-flow-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "\u53d6\u6d88" });
    cancelButton.addEventListener("click", () => this.close());
    const openButton = actions.createEl("button", { text: "\u65b0\u6807\u7b7e\u9875\u6253\u5f00\u6708\u6587\u6863" });
    openButton.addEventListener("click", () => {
      this.close();
      void this.onOpenTarget().catch((error) => {
        console.error("Task Flow: failed to open target month file", error);
        new Notice(error instanceof Error ? error.message : "\u6253\u5f00\u6708\u6587\u6863\u5931\u8d25");
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DateChoiceModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly dates: Array<{ key: string; label: string }>,
    private readonly onChoose: (dayKey: string) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    const dates = this.contentEl.createDiv({ cls: "task-flow-date-choice-list" });
    for (const date of this.dates) {
      const button = dates.createEl("button", { text: date.label });
      button.addEventListener("click", () => {
        void this.choose(date.key);
      });
    }
    const cancelButton = this.contentEl.createEl("button", {
      cls: "task-flow-date-choice-cancel",
      text: "退出"
    });
    cancelButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async choose(dayKey: string): Promise<void> {
    try {
      await this.onChoose(dayKey);
      this.close();
    } catch (error) {
      console.error("Task Flow: failed to choose date", error);
      new Notice(error instanceof Error ? error.message : "操作失败");
    }
  }
}

interface DeleteConfirmConfig {
  title: string;
  message: string;
  isSevere: boolean;
  onConfirm: () => Promise<void>;
}

function buildDeleteConfirmConfig(
  preview: DeletionPreview
): DeleteConfirmConfig {
  const name = preview.taskName;
  let message = "";
  let isSevere = false;

  switch (preview.level) {
    case "root_continuation": {
      // Level 4: 延续根继承
      isSevere = true;
      const info = preview.continuationInfo!;
      message = `确定要删除"${name}"吗？\n\n这是延续链的根任务。删除后：\n\n`;
      message += `  · 根任务"${info.deletedTaskName}"将被删除\n`;

      if (info.children.length > 0) {
        message += `  · 其 ${info.children.length} 个子任务也将一并删除：\n`;
        for (const child of info.children) {
          if (child.action === "promote" && child.promoteDate) {
            message += `    · "${child.name}" — ${child.promoteDate} 的延续实例将升级为新的根子任务\n`;
          } else {
            message += `    · "${child.name}" — 无延续实例，直接删除\n`;
          }
        }
      }

      if (info.newRootName && info.newRootDate) {
        message += `  · ${info.newRootDate} 的延续实例"${info.newRootName}"将升级为新的根任务\n`;
      }

      if (info.unchangedCount > 0) {
        message += `  · 其他 ${info.unchangedCount} 个延续实例不受影响\n`;
      }

      message += `\n此操作不可恢复。`;
      break;
    }

    case "cross_area": {
      // Level 3: 跨区域级联
      isSevere = true;
      const childPart = preview.childNames.length > 0
        ? `包含 ${preview.childNames.length} 个子任务，`
        : "";

      if (preview.dayInstances.length > 0) {
        message = `确定要删除"${name}"吗？\n\n`;
        message += `该任务${childPart}已安排到以下日期，对应的日任务实例也将删除：\n\n`;
        for (const inst of preview.dayInstances) {
          message += `  · ${inst.date} — "${inst.name}"\n`;
        }
        const instanceWord = preview.dayInstances.length;
        message += `\n共删除 1 个周任务${childPart ? `、${preview.childNames.length} 个子任务` : ""}和 ${instanceWord} 个日任务实例。此操作不可恢复。`;
      } else {
        message = `确定要删除"${name}"吗？\n\n`;
        message += `其下的子任务也将一并删除：\n\n`;
        for (const cn of preview.childNames) {
          message += `  · ${cn}\n`;
        }
        message += `\n共删除 1 个父任务和 ${preview.childNames.length} 个子任务。此操作不可恢复。`;
      }
      break;
    }

    case "parent_cascade": {
      // Level 2: 父任务级联
      message = `确定要删除"${name}"吗？\n\n`;
      message += `其下的子任务也将一并删除：\n\n`;
      for (const cn of preview.childNames) {
        message += `  · ${cn}\n`;
      }
      message += `\n共删除 1 个父任务和 ${preview.childNames.length} 个子任务。此操作不可恢复。`;
      break;
    }

    default: {
      // Level 1: 简单删除
      message = `确定要删除"${name}"吗？\n\n此操作不可恢复。`;
      break;
    }
  }

  // Append empty parent warnings
  if (preview.emptyParentWarnings.length > 0) {
    message += `\n\n注意：`;
    for (const warn of preview.emptyParentWarnings) {
      message += `\n${warn.date} 的日父任务"${warn.parentName}"将因子任务全部移除而一并删除。`;
    }
  }

  return {
    title: "确认删除",
    message,
    isSevere,
    onConfirm: async () => {}
  };
}

class DeleteConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly config: DeleteConfirmConfig
  ) {
    super(app);
  }

  onOpen(): void {
    if (this.config.isSevere) {
      this.titleEl.addClass("task-flow-severe-title");
    }
    this.titleEl.setText(this.config.title);
    this.contentEl.createDiv({
      cls: `task-flow-modal-message${this.config.isSevere ? " is-severe" : ""}`,
      text: this.config.message
    });
    const actions = this.contentEl.createDiv({ cls: "task-flow-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
    const confirmButton = actions.createEl("button", {
      cls: this.config.isSevere ? "task-flow-danger-button" : undefined,
      text: this.config.isSevere ? "确认全部删除" : "确认删除"
    });
    confirmButton.addEventListener("click", () => {
      this.confirmed = true;
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.confirmed) {
      void this.config.onConfirm();
    }
  }
}

class TasklogDeleteConflictModal extends Modal {
  constructor(
    app: App,
    private readonly taskIds: string[],
    private readonly onUnbindAndDelete: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("发现关联工作记录");
    this.contentEl.createDiv({
      cls: "task-flow-modal-message",
      text: `将删除的任务中有 ${this.taskIds.length} 项仍绑定工作记录。请选择保留任务，或解除绑定后继续删除。`,
    });
    for (const id of this.taskIds) {
      this.contentEl.createDiv({ cls: "task-flow-task-subtitle", text: `tasklog:: ${id}` });
    }
    const actions = this.contentEl.createDiv({ cls: "task-flow-modal-actions" });
    const keepButton = actions.createEl("button", { text: "保留任务" });
    keepButton.addEventListener("click", () => this.close());
    const unbindButton = actions.createEl("button", {
      cls: "task-flow-danger-button",
      text: "解除绑定并删除",
    });
    unbindButton.addEventListener("click", () => {
      this.close();
      void this.onUnbindAndDelete().catch((error) => {
        console.error("Task Flow: failed to unbind tasklog and delete", error);
        new Notice(error instanceof Error ? error.message : "解除绑定并删除失败");
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
