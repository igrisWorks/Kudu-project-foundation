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
    enabled: boolean;
    message: string;
    prerequisites: string[];
  }

  interface KuduDesktopBridge {
    connectServer(request: DesktopConnectionRequest): Promise<DesktopConnectionResult>;
    getLocalModeInfo(): Promise<DesktopLocalModeInfo>;
    startLocal(): Promise<DesktopConnectionResult>;
  }

  interface Window {
    kuduDesktop?: KuduDesktopBridge;
    kuduLocal?: { revealDataDirectory(): Promise<void> };
  }
}

export {};
