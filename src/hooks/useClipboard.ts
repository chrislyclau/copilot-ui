import { useState } from 'react';

export function useClipboard() {
  const [copiedText, setCopiedText] = useState<string | undefined>(undefined);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => {
      setCopiedText(undefined);
    }, 2000);
  };

  return { copiedText, copyToClipboard };
}
