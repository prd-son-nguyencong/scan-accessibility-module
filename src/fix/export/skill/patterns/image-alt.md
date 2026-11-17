# image-alt: informative images described, decorative images empty

Intent: decide whether the image carries information. Informative gets a short `alt`; decorative gets `alt=""`.

Before:

```liquid
<img src="{{data:hero.image}}" class="w-full">
```

After (informative, text from data in the sidecar):

```liquid
<img src="{{data:hero.image}}" class="w-full" alt="{{data:hero.imageAlt}}">
```

After (decorative):

```liquid
<img src="/assets/divider.svg" class="w-full" alt="">
```

Cautions:
- Informative alt is at most about 125 characters, not the file name, not "image of".
- Do not repeat adjacent visible text verbatim; if the text next to it says the same, the image is decorative.
- An image that is the only content of a link or button names that control: describe the destination or action.
- Decorative SVG and CSS background graphics use `aria-hidden="true"`.
- If you cannot tell what the image shows, ask (`when-to-ask-a-human.md`); do not invent text.
- In a loop, per-item alt comes from the sidecar, never one hard-coded string.

Verify: rescan; `image-alt` gone. Check the rendered `alt` attribute on the page.

Do not:
- Do not omit the attribute on decorative images; an empty `alt=""` is required.
- Do not use placeholder alt such as "image" or "photo".
- Do not remove the image.
