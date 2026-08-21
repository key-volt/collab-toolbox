// Patched from upstream for the current Excalidraw generation: type imports follow the
// 0.18 export map, element types are local structural declarations, remote scene
// updates carry CaptureUpdateAction.NEVER so they stay out of Excalidraw's own history
// (undo is Yjs-managed here), and the optional awareness/undo handles are guarded so
// the file compiles under strict TypeScript. The binding logic is upstream's.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type {
  BinaryFileData,
  Collaborator,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs"
import { areElementsSame, debounce, yjsToExcalidraw } from "./helpers";
import { applyAssetOperations, applyElementOperations, getDeltaOperationsForAssets, getDeltaOperationsForElements, type LastKnownOrderedElement, type Operation } from "./diff";
export { yjsToExcalidraw }

/**
 * Local patch: pasted images can be kept out of the shared document. When an asset
 * store is supplied, a new file's bytes are handed to it and only a light reference
 * {id, mimeType, uploadId} enters yAssets; peers resolve the reference back into a
 * BinaryFileData through the same store. Without a store, upstream behaviour (full
 * data URLs inside the document) is unchanged.
 */
export type StoredAsset = { id: string; mimeType: string; uploadId: string };

export interface AssetStore {
  store(file: BinaryFileData): Promise<StoredAsset>;
  load(asset: StoredAsset): Promise<BinaryFileData>;
}

export class ExcalidrawBinding {
  yElements: Y.Array<Y.Map<any>>
  yAssets: Y.Map<any>
  api: ExcalidrawImperativeAPI;
  awareness?: awarenessProtocol.Awareness;
  undoManager?: Y.UndoManager;

  subscriptions: (() => void)[] = [];
  collaborators: Map<string, Collaborator> = new Map();
  lastKnownElements: LastKnownOrderedElement[] = []
  lastKnownFileIds: Set<string> = new Set();
  assetStore?: AssetStore;
  private pendingAssetUploads: Set<string> = new Set();

  constructor(yElements: Y.Array<Y.Map<any>>, yAssets: Y.Map<any>, api: ExcalidrawImperativeAPI, awareness?: awarenessProtocol.Awareness, undoConfig?: {excalidrawDom: HTMLElement, undoManager: Y.UndoManager}, assetStore?: AssetStore) {
    this.yElements = yElements;
    this.yAssets = yAssets;
    this.api = api;
    this.awareness = awareness;
    this.assetStore = assetStore;
    const excalidrawDom = undoConfig?.excalidrawDom
    this.undoManager = undoConfig?.undoManager

    // Listener for changes made on excalidraw by current user
    this.subscriptions.push(
      this.api.onChange((_, state, files) => {
        // TODO: Excalidraw doesn't delete the asset from the map when the associated item is deleted.
        const elements = this.api.getSceneElements()  // This returns without deleted elements

        // This fires very often even when data is not changed, so keeping a fast procedure to check if anything changed or not
        // Even on move operations, the version property changes so this should work
        let operations: Operation[] = []
        if (!areElementsSame(this.lastKnownElements, elements)) {
          const res = getDeltaOperationsForElements(this.lastKnownElements, elements)
          operations = res.operations
          this.lastKnownElements = res.lastKnownElements
          applyElementOperations(this.yElements, operations, this)
        }

        const res = getDeltaOperationsForAssets(this.lastKnownFileIds, files)
        const assetOperations = res.operations
        this.lastKnownFileIds = res.lastKnownFileIds
        if (assetOperations.length > 0) {
          const store = this.assetStore
          if (store) {
            for (const op of assetOperations) {
              if (op.type !== "append") continue
              if (this.pendingAssetUploads.has(op.id) || this.yAssets.has(op.id)) continue
              this.pendingAssetUploads.add(op.id)
              store.store(op.asset)
                .then((stored) => {
                  this.yAssets.doc!.transact(() => { this.yAssets.set(op.id, stored) }, this)
                })
                .catch((error) => { console.warn("[y-excalidraw] asset upload failed:", error) })
                .finally(() => { this.pendingAssetUploads.delete(op.id) })
            }
          } else {
            applyAssetOperations(this.yAssets, assetOperations, this)
          }
        }

        if (this.awareness) {
          // update selected awareness
          this.awareness.setLocalStateField(
            "selectedElementIds",
            state.selectedElementIds,
          );
        }
      }),
    );

    // Listener for changes made on yElements by remote users
    const _remoteElementsChangeHandler = (event: Array<Y.YEvent<any>>, txn: Y.Transaction) => {
      if (txn.origin === this) {
        return
      }

      // Get changed elements from events
      const changedElementIds = new Set(event.flatMap(e => {
        if (e instanceof Y.YMapEvent) {
         return [(e.target as Y.Map<any>).get("el").id as string]
        }
        return []
      }));

      const remoteElements = yjsToExcalidraw(this.yElements);
      const elements = remoteElements.map(el => {
        if (changedElementIds.has(el.id)) {
          return el;
        }
        return this.api.getSceneElements().find(existingEl => existingEl.id === el.id) || el;
      });

      this.lastKnownElements = this.yElements.toArray()
        .map((x) => ({ id: x.get("el").id as string, version: x.get("el").version as number, pos: x.get("pos") as string }))
        .sort((a, b) => {
          const key1 = a.pos;
          const key2 = b.pos;
          return key1 > key2 ? 1 : (key1 < key2 ? -1 : 0)
        })
      this.api.updateScene({ elements: elements as never[], captureUpdate: CaptureUpdateAction.NEVER })
    }
    this.yElements.observeDeep(_remoteElementsChangeHandler)
    this.subscriptions.push(() => this.yElements.unobserveDeep(_remoteElementsChangeHandler))

    // Listener for changes made on yAssets by remote users
    const _remoteFilesChangeHandler = (events: Y.YMapEvent<any>, txn: Y.Transaction) => {
      if (txn.origin === this) {
        return
      }

      const entries = [...events.keysChanged]
        .map((key) => this.yAssets.get(key) as BinaryFileData | StoredAsset | undefined)
        .filter((entry): entry is BinaryFileData | StoredAsset => entry != null);
      this.addResolvedFiles(entries);
    }
    this.yAssets.observe(_remoteFilesChangeHandler);  // only observe and not observe deep as assets are only added/deleted not updated
    this.subscriptions.push(() => {
      this.yAssets.unobserve(_remoteFilesChangeHandler);
    });

    const bindingAwareness = this.awareness;
    if (bindingAwareness) {
      // Listener for awareness changes made by remote users.
      // Patched: the collaborator map is rebuilt from every state on each change, and a
      // peer whose `pageId` differs from ours is left out — cursors stay on the page
      // they belong to when a document has several pages sharing one room.
      const _remoteAwarenessChangeHandler = () => {
        const states = bindingAwareness.getStates();
        const localPageId = (
          bindingAwareness.getLocalState() as { pageId?: unknown } | null
        )?.pageId;

        const collaborators = new Map<string, Collaborator>();
        for (const [id, state] of states) {
          if (id === bindingAwareness.clientID) continue;
          const remotePageId = (state as { pageId?: unknown }).pageId;
          if (localPageId != null && remotePageId != null && remotePageId !== localPageId) {
            continue;
          }
          collaborators.set(id.toString(), {
            pointer: state.pointer,
            button: state.button,
            selectedElementIds: state.selectedElementIds,
            username: state.user?.name,
            color: state.user?.color,
            avatarUrl: state.user?.avatarUrl,
            userState: state.user?.state,
          } as Collaborator);
        }
        this.api.updateScene({ collaborators: collaborators as never });
        this.collaborators = collaborators;
      };
      bindingAwareness.on("change", _remoteAwarenessChangeHandler);
      this.subscriptions.push(() => {
        bindingAwareness.off("change", _remoteAwarenessChangeHandler);
      });
    }

    const undoManager = this.undoManager;
    if (undoManager && excalidrawDom) {
      this.setupUndoRedo(excalidrawDom, undoManager)
    }

    // init elements
    const initialValue = yjsToExcalidraw(this.yElements)
    this.lastKnownElements = this.yElements.toArray()
      .map((x) => ({ id: x.get("el").id as string, version: x.get("el").version as number, pos: x.get("pos") as string }))
      .sort((a, b) => {
        const key1 = a.pos;
        const key2 = b.pos;
        return key1 > key2 ? 1 : (key1 < key2 ? -1 : 0)
      })
    this.api.updateScene({ elements: initialValue as never[], captureUpdate: CaptureUpdateAction.NEVER });

    // init assets
    this.addResolvedFiles(
      [...this.yAssets.keys()]
        .map((key) => this.yAssets.get(key) as BinaryFileData | StoredAsset | undefined)
        .filter((entry): entry is BinaryFileData | StoredAsset => entry != null),
    );

    // init collaborators
    if (bindingAwareness) {
      const collaborators = new Map<string, Collaborator>()
      for (const id of bindingAwareness.getStates().keys()) {
        const state = bindingAwareness.getStates().get(id)
        if (!state) continue
        collaborators.set(id.toString(), {
          pointer: state.pointer,
          button: state.button,
          selectedElementIds: state.selectedElementIds,
          username: state.user?.name,
          color: state.user?.color,
          avatarUrl: state.user?.avatarUrl,
          userState: state.user?.state,
        } as Collaborator);
      }
      this.api.updateScene({ collaborators: collaborators as never });
      this.collaborators = collaborators;
    }
  }

  private addResolvedFiles(entries: (BinaryFileData | StoredAsset)[]) {
    const ready: BinaryFileData[] = []
    for (const entry of entries) {
      if ("dataURL" in entry) {
        ready.push(entry)
      } else if (this.assetStore) {
        this.assetStore.load(entry)
          .then((file) => this.api.addFiles([file]))
          .catch((error) => { console.warn("[y-excalidraw] asset load failed:", error) })
      }
    }
    if (ready.length > 0) {
      this.api.addFiles(ready)
    }
  }

  public onPointerUpdate = (payload: {
    pointer: {
      x: number;
      y: number;
      tool: "pointer" | "laser";
    };
    button: "down" | "up";
  }) => {
    if (this.awareness) {
      this.awareness.setLocalStateField("pointer", payload.pointer);
      this.awareness.setLocalStateField("button", payload.button);
    }
  };

  private setupUndoRedo(excalidrawDom: HTMLElement, undoManager: Y.UndoManager) {
    undoManager.addTrackedOrigin(this)
    this.subscriptions.push(() => undoManager.removeTrackedOrigin(this))

    // listen for undo/redo keys
    const _keyPressHandler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key?.toLocaleLowerCase() === 'z') {
        event.stopPropagation();
        undoManager.redo()
      }
      else if (event.ctrlKey && event.key?.toLocaleLowerCase() === 'z') {
        event.stopPropagation();
        undoManager.undo()
      }
    }
    excalidrawDom.addEventListener('keydown', _keyPressHandler, { capture: true });
    this.subscriptions.push(() => excalidrawDom?.removeEventListener('keydown', _keyPressHandler, { capture: true }))

    // hijack the undo/redo buttons
    // these get destroyed/recreated when view changes from desktop->mobile, so the listeners need to be added again
    let undoButton: HTMLButtonElement | null = null;
    let redoButton: HTMLButtonElement | null = null;

    const _undoBtnHandler = (event: Event) => {
      event.stopImmediatePropagation();
      undoManager.undo()
    }
    const _redoBtnHandler = (event: Event) => {
      event.stopImmediatePropagation();
      undoManager.redo()
    }

    const _resizeListener = () => {
      if (!undoButton || !undoButton.isConnected) {
        undoButton?.removeEventListener('click', _undoBtnHandler)
        undoButton = excalidrawDom.querySelector('[aria-label="Undo"]');  // Assuming new undoButton is added to dom by now
        undoButton?.addEventListener('click', _undoBtnHandler);
      }

      if (!redoButton || !redoButton.isConnected) {
        redoButton?.removeEventListener('click', _redoBtnHandler)
        redoButton = excalidrawDom.querySelector('[aria-label="Redo"]');  // Assuming new redoButton is added to dom by now
        redoButton?.addEventListener('click', _redoBtnHandler);
      }
    }

    const ro = new ResizeObserver(debounce(_resizeListener, 100))
    ro.observe(excalidrawDom)

    // Call resize on init
    _resizeListener()

    this.subscriptions.push(() => undoButton?.removeEventListener('click', _undoBtnHandler))
    this.subscriptions.push(() => redoButton?.removeEventListener('click', _redoBtnHandler))
    this.subscriptions.push(() => ro.disconnect())
  }

  destroy() {
    for (const s of this.subscriptions) {
      s();
    }
  }
}
