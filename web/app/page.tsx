import { en } from '../lib/i18n/dictionaries/en';

export default function Home() {
  return <main className="flex items-center justify-center h-screen text-text-muted">{en.common.appName}</main>;
}
