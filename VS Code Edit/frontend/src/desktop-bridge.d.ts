declare global {
  interface DesktopConnectionRequest {
    url: string;
    allowInsecureHttp: boolean;
  }

  interface DesktopConnectionResult {
    status: "connected" | "cancelled" | "error";
    message?: string;
  }

  interface DesktopLocalModeInfo {
    enabled: false;
    message: string;
    prerequisites: string[];
  }

  interface KuduDesktopBridge {
    connectServer(request: DesktopConnectionRequest): Promise<DesktopConnectionResult>;
    getLocalModeInfo(): Promise<DesktopLocalModeInfo>;
  }

  interface Window {
    kuduDesktop?: KuduDesktopBridge;
  }
}

export {};
