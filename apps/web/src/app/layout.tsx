import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = { title: "co founder console", description: "review and operate co" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

