try {
  const theme = localStorage.getItem('theme')
  if (theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark')
  }
} catch {
  // Storage can be unavailable in hardened browser contexts; light mode is safe.
}
