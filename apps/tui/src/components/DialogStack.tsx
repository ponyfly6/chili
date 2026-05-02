import type { TeamLiveAction } from "@chili/sdk";
import type { TuiTheme } from "../theme/index.js";
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
  theme: TuiTheme;
}) {
  const { theme } = props;
  return (
    <>
      {props.helpOpen ? <HelpOverlay theme={theme} /> : null}
      {props.confirm ? (
        <box position="absolute" left={8} top={5} width="78%" height={8} flexDirection="column" border borderStyle="double" borderColor={theme.colors.status.warning} backgroundColor={theme.colors.overlay} zIndex={30} paddingX={2} paddingY={1}>
          <text fg={theme.colors.text.primary} truncate>{props.confirm.title}</text>
          <text fg={theme.colors.text.secondary} truncate>{shorten(actionLabel(props.confirm.action), 96)}</text>
          <text fg={theme.colors.status.warning} truncate>{"Enter confirms. Esc cancels."}</text>
        </box>
      ) : null}
    </>
  );
}
