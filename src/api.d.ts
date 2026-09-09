export {};
declare global {
  interface Window {
    companion: {
      getModel(): Promise<ArrayBuffer | null>;
      ready(state: {ok: boolean; error?: string}): void;
      onVisibility(callback: (visible: boolean) => void): () => void;
      onModelChanged(callback: () => void): () => void;
      onStatusChanged(callback: () => void): () => void;
      onMoveMode(callback: (state: {active: boolean; revision: number}) => void): () => void;
      submitMoveShape(revision: number, rects: Array<{x: number; y: number; width: number; height: number}>): Promise<boolean>;
      movePointer(revision: number, kind: 'start'|'move'|'end'|'cancel', point?: {x: number; y: number}): void;
      action(action: 'show'|'hide'|'reset'|'choose-model'|'quit'|'left'|'right'|'up'|'down'|'move-mode'): Promise<void>;
      getStatus(): Promise<{model: string; error: string; shortcuts: boolean; moving: boolean; loaded: boolean}>;
    };
  }
}
