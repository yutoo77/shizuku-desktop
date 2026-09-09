export {};
declare global {
  interface Window {
    companion: {
      getModel(): Promise<ArrayBuffer | null>;
      ready(state: {ok: boolean; error?: string; recovering?: boolean}): void;
      onVisibility(callback: (visible: boolean) => void): () => void;
      onModelChanged(callback: () => void): () => void;
      onCalled(callback: (expiresAt: number) => void): () => void;
      onPosture(callback: (posture: 'standing' | 'sitting') => void): () => void;
      onStatusChanged(callback: () => void): () => void;
      onMoveMode(callback: (state: {active: boolean; revision: number}) => void): () => void;
      submitMoveShape(revision: number, rects: Array<{x: number; y: number; width: number; height: number}>): Promise<boolean>;
      movePointer(revision: number, kind: 'start'|'move'|'end'|'cancel', point?: {x: number; y: number}): void;
      action(action: 'show'|'hide'|'reset'|'call'|'choose-model'|'quit'|'left'|'right'|'up'|'down'|'move-mode'|'size-small'|'size-standard'|'size-large'|'stand'|'sit'): Promise<void>;
      getStatus(): Promise<{model: string; error: string; shortcuts: boolean; moving: boolean; loaded: boolean; scale: number; posture: 'standing' | 'sitting'}>;
    };
  }
}
