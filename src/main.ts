import { Editor, Menu, Plugin, WorkspaceLeaf } from "obsidian";
import { TaskFlowV2Store } from "./v2/store/v2Store";
import { TASK_FLOW_VIEW_TYPE, TaskFlowView } from "./v2/view";

export default class TaskFlowPlugin extends Plugin {
  store!: TaskFlowV2Store;

  async onload(): Promise<void> {
    this.store = new TaskFlowV2Store(this);
    await this.store.load();

    this.registerView(
      TASK_FLOW_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new TaskFlowView(leaf, this.store)
    );

    this.addRibbonIcon("list-checks", "Open Task Flow", () => {
      void this.activateTaskFlowView();
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        menu.addItem((item) => {
          item
            .setTitle("创建 Week 区域")
            .setIcon("calendar-plus")
            .onClick(() => {
              const cursor = editor.getCursor();
              const block = "%% week: %%\n%% week end %%";
              editor.replaceRange(block, cursor);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("创建 Day 区域")
            .setIcon("calendar-plus")
            .onClick(() => {
              const cursor = editor.getCursor();
              const block = "%% day: %%\n%% day end %%";
              editor.replaceRange(block, cursor);
            });
        });
      })
    );
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(TASK_FLOW_VIEW_TYPE);
  }

  async onExternalSettingsChange(): Promise<void> {
    await this.store.reloadExternal();
  }

  private async activateTaskFlowView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(TASK_FLOW_VIEW_TYPE)[0];

    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      return;
    }

    await leaf.setViewState({
      type: TASK_FLOW_VIEW_TYPE,
      active: true
    });
    await this.app.workspace.revealLeaf(leaf);
  }
}
