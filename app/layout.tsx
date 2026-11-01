import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "MindPulse — Your daily wellbeing, in focus", description: "A calm, personal space for heart trends, daily activity and intentional progress." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }