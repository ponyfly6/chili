import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Chili · 终端优先的 Coding Agent";
const description = "Chili 是一个本地运行、终端优先、真正面向代码库工作的 coding agent runtime 与 CLI。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost ?? requestHeaders.get("host") ?? "localhost:3000";
  const safeHost = /^[a-z0-9.-]+(?::\d+)?$/i.test(requestHost) ? requestHost : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const hostname = safeHost.replace(/:\d+$/, "");
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : isLoopback
      ? "http"
      : "https";
  const origin = new URL(`${protocol}://${safeHost}`);
  const socialImage = new URL("/og.png", origin).toString();

  return {
    metadataBase: origin,
    title,
    description,
    alternates: { canonical: origin },
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      url: origin,
      siteName: "Chili 辣椒",
      title,
      description,
      images: [{ url: socialImage, width: 1200, height: 630, alt: "Chili · 进仓库，把事情做完。" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
