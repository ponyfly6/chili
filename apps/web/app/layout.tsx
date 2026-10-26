import type { Metadata } from "next";
import "./globals.css";

const title = "Chili · 为你做事的个人 AI";
const description = "认识 Chili，为你做事的个人 AI。在自己的电脑上把需求变成成果，查看结果、继续修改，探索手机接续与个人代理的未来。";

const origin = new URL("https://usechili.com");
const socialImage = new URL("/og.png", origin).toString();

export const metadata: Metadata = {
  metadataBase: origin,
  title,
  description,
  alternates: { canonical: origin },
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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        {/* Chrome ignores icon links emitted into the body by streamed metadata. */}
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" type="image/x-icon" />
        <link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png" />
        <link rel="icon" href="/favicon.svg" sizes="any" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" type="image/png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
