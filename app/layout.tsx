import type {Metadata} from 'next';
import './globals.css';

export const metadata: Metadata = {title: 'SE Widget Studio', description: 'A personal workspace for widget previews, themes, and visual assets.', robots: {index: false, follow: false}};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
