# form-labels: every field has a visible, bound label

Intent: each `input`, `select` and `textarea` has a visible `<label for>` matching its `id`.

Before:

```liquid
<input type="email" placeholder="Email" class="border px-2">
```

After:

```liquid
<label for="newsletter-email" class="sr-only">Email</label>
<input id="newsletter-email" type="email" autocomplete="email" placeholder="Email" class="border px-2">
```

Cautions:
- The label text must be visible unless the design shows only a placeholder; then `sr-only` is acceptable, and the question of
  adding a visible label goes to the design owner.
- In a loop, build the id with `forloop.index` and use the same expression in `for`.
- Match `type` and `autocomplete` to the purpose (email, tel, url) only when the purpose is certain.
- Related radios or checkboxes sit in `fieldset` with `legend`.
- Required fields use the `required` attribute. Errors use `aria-invalid="true"` and `aria-describedby` to visible text.

Verify: rescan; `label` gone. Click the label text: focus moves to the field.

Do not:
- Do not use `placeholder` or `title` as the label.
- Do not wrap the input in a label and drop `for`/`id` when the project binds them explicitly.
- Do not change field names or ids that scripts or the platform read.
