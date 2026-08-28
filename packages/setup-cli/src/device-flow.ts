import {
  completeDeviceFlow,
  type DeviceAuthorizationDependencies,
  type DeviceFlowResult,
} from "agent-bridge";

export interface DeviceFlowDependencies extends DeviceAuthorizationDependencies {
  readonly openBrowser: (url: string) => Promise<void>;
  readonly onManualApprovalRequired?: (url: string) => Promise<void> | void;
}

export { completeDeviceFlow, type DeviceFlowResult };
