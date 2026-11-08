const cards = document.querySelectorAll('[data-slide]');
cards.forEach((card, index) => {
  if (index === 0) {
    card.removeAttribute("role");
  } else {
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Show slide ${index + 1}`);
  }
});
