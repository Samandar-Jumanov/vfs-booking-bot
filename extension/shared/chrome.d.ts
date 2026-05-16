declare namespace chrome {
  namespace alarms {
    interface Alarm {
      name: string;
    }
    const onAlarm: { addListener(listener: (alarm: Alarm) => void): void };
    function create(name: string, alarmInfo: { periodInMinutes: number }): void;
  }

  namespace runtime {
    const onInstalled: { addListener(listener: () => void): void };
    const onStartup: { addListener(listener: () => void): void };
    const onMessage: { addListener(listener: (message: any, sender: unknown, sendResponse: (response?: any) => void) => boolean | void): void };
    function sendMessage(message: any): Promise<any>;
    function openOptionsPage(): void;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
    }
    function create(createProperties: { url: string }): Promise<Tab>;
    function query(queryInfo: { url: string }): Promise<Tab[]>;
    function sendMessage(tabId: number, message: any): Promise<any>;
  }

  namespace storage {
    namespace local {
      function get(defaults: Record<string, unknown>): Promise<Record<string, unknown>>;
      function set(values: Record<string, unknown>): Promise<void>;
    }
  }

  namespace notifications {
    function create(options: { type: 'basic'; iconUrl: string; title: string; message: string }): void;
  }
}
