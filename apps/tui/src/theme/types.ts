export interface TuiTheme {
  id: string;
  name: string;
  colors: {
    background: string;
    panel: string;
    overlay: string;
    text: {
      primary: string;
      secondary: string;
      muted: string;
      disabled: string;
      inverse: string;
    };
    border: {
      subtle: string;
      default: string;
      focus: string;
      warning: string;
      danger: string;
    };
    accent: {
      primary: string;
      secondary: string;
      muted: string;
    };
    status: {
      success: string;
      warning: string;
      error: string;
      info: string;
      pending: string;
    };
    input: {
      background: string;
      text: string;
      placeholder: string;
      cursor: string;
      disabledText: string;
      disabledBorder: string;
    };
    menu: {
      background: string;
      selectedBackground: string;
      selectedText: string;
      text: string;
      muted: string;
    };
  };
}
