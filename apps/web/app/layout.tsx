import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Chili · 为你做事的个人 AI";
const description = "认识 Chili，为你做事的个人 AI。在自己的电脑上把需求变成成果，查看结果、继续修改，探索手机接续与个人代理的未来。";

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
