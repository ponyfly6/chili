import type { ReactNode } from "react";

export type IconName = "menu" | "more" | "chevron-left" | "chevron-right" | "chevron-down" | "close" | "laptop" | "search" | "arrow-up" | "queue" | "reply" | "check" | "refresh" | "stop" | "alert" | "lock" | "shield" | "chat" | "clock" | "disconnect" | "trash";

export function Icon({ name, size = 21, className }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    menu: <><path d="M4 6h16M4 12h12M4 18h16" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    "chevron-left": <path d="m15 5-7 7 7 7" />,
    "chevron-right": <path d="m9 5 7 7-7 7" />,
    "chevron-down": <path d="m6 9 6 6 6-6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    laptop: <><rect x="5" y="4" width="14" height="11" rx="1.5" /><path d="m5 15-3 4c-.4.6 0 1 1 1h18c1 0 1.4-.4 1-1l-3-4M9 17h6" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    "arrow-up": <path d="M12 20V4m-6 6 6-6 6 6" />,
    queue: <><path d="M5 5h14M5 10h14M5 15h8m3 0 3 3-3 3m-1-3h6" /></>,
    reply: <><path d="m9 5-6 5 6 5M3 10h10c5 0 8 3 8 9" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    refresh: <><path d="M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    alert: <><path d="m10.3 4-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0ZM12 9v5" /><path d="M12 17h.01" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    chat: <path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    disconnect: <><path d="m6 3 15 18M4 8l4-4m8 12 4-4M8 4l3 3m6 6 3 3M4 8l4 4c2 2 5 2 7 0m-7 0-4 4m12 0-4 4" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
