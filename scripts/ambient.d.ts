// Browser and Electron APIs the smokes call inside `evaluate` callbacks that the shipped typings do not declare.
interface WindowControlsOverlay {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

interface Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlay;
}

declare namespace Electron {
  interface WebContents {
    getLastWebPreferences(): WebPreferences | undefined;
  }
}

declare module "*.sh" {
  const text: string;
  export default text;
}
