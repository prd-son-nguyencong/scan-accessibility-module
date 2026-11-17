function wire(button, panel) {
  button.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
}
wire(document.getElementById('menu-btn'), document.getElementById('primary-nav'));
wire(document.querySelector('.disc-btn'), document.getElementById('products-panel'));
