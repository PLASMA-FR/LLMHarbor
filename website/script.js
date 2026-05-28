document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = button.getAttribute('data-copy');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = old; }, 1400);
    } catch {
      button.textContent = 'Copy failed';
      setTimeout(() => { button.textContent = 'Copy'; }, 1400);
    }
  });
});

const scene = document.querySelector('.pitch-scene');
if (scene && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  scene.addEventListener('pointermove', (event) => {
    const rect = scene.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 8;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * -5;
    scene.style.transform = `rotateX(${y}deg) rotateY(${x}deg)`;
  });
  scene.addEventListener('pointerleave', () => {
    scene.style.transform = '';
  });
}
