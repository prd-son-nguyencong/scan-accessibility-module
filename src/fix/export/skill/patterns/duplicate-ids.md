# duplicate-ids: unique ids, with every reference updated

Intent: an id appears once per page; references (`aria-controls`, `aria-labelledby`, `for`, `href="#.."`, scripts) still resolve.

Before:

```liquid
{% for item in items %}
  <button aria-controls="panel">{{data:item.title}}</button>
  <div id="panel">...</div>
{% endfor %}
```

After:

```liquid
{% for item in items %}
  <button aria-controls="panel-{{ forloop.index }}">{{data:item.title}}</button>
  <div id="panel-{{ forloop.index }}">...</div>
{% endfor %}
```

Cautions:
- Use `forloop.index` (`forloop.parentloop.index` in nested loops); never hard-code an id in a loop; avoid assign and capture.
- Search the markup and `src/scripts/` for every use of the old id and update them together.
- A sprite `<use href="#id">` referencing a symbol is not reported (not an accessibility reference).
- A partial rendered twice on one page has duplicate ids by construction: make the id depend on a value passed in.

Verify: rescan; the duplicate rules gone. `document.querySelectorAll('[id="x"]').length` is 1 for the changed ids.

Do not:
- Do not rename an id used by platform or vendor code.
- Do not change only the id and leave a reference behind.
- Do not use random values; ids must be stable between renders.
