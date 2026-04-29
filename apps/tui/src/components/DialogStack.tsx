import type { TeamLiveAction } from "@chili/sdk";
import { actionLabel, shorten } from "./helpers.js";
import { HelpOverlay } from "./HelpOverlay.js";

export interface ConfirmDialogState {
  action: TeamLiveAction;
  title: string;
}

export function DialogStack(props: {
  helpOpen: boolean;
  confirm?: ConfirmDialogState | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      {props.helpOpen ? <HelpOverlay /> : null}
      {props.confirm ? (
        <box position="absolute" left={8} top={5} width="78%" height={8} flexDirection="column" border borderStyle="double" borderColor="#ffd166" backgroundColor="#111827" zIndex={30} paddingX={2} paddingY={1}>
          <text fg="#f8f8f2" truncate>{props.confirm.title}</text>
          <text fg="#d8dee9" truncate>{shorten(actionLabel(props.confirm.action), 96)}</text>
          <text fg="#ffd166" truncate>{"Enter confirms. Esc cancels."}</text>
        </box>
      ) : null}
    </>
  );
}
