/** Native saves may stay open indefinitely; revoke their blob only after completion/cancel. */
export async function downloadFile(blob: Blob, name: string): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  let finished: Promise<boolean> | undefined;
  if (import.meta.env.VITE_TRESTL_DESKTOP === 'true') {
    finished = new Promise((resolve, reject) => {
      const listener = (event: Event) => {
        const result = (event as CustomEvent<{ url: string; status: string }>).detail;
        if (result.url !== url) return;
        window.removeEventListener('trestl:download', listener);
        URL.revokeObjectURL(url);
        if (result.status === 'failed')
          reject(new Error('The file could not be saved. Please try again.'));
        else resolve(result.status === 'saved');
      };
      window.addEventListener('trestl:download', listener);
    });
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (finished) return finished;
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
