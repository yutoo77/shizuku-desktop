export {};
declare global {
  interface Window {
    companion: {
      getModel(): Promise<ArrayBuffer | null>;
      ready(state: {ok: boolean; error?: string}): void;
      onVisibility(callback: (visible: boolean) => void): () => void;
      onModelChanged(callback: () => void): () => void;
      onStatusChanged(callback: () => void): () => void;
      action(action: 'show'|'hide'|'reset'|'choose-model'|'quit'|'left'|'right'|'up'|'down'): Promise<void>;
      getStatus(): Promise<{model: string; error: string; shortcuts: boolean}>;
    };
  }
}
