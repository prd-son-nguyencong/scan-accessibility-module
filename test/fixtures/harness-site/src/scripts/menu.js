const btn = document.getElementById('menu-btn');
const nav = document.getElementById('site-nav');
btn.addEventListener('click', () => {
  const open = nav.hidden;
  nav.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
});
