// @ts-check
// The page a phone opens from the QR code a TV shows (`<server>/connect#<invite>`): it hands the invite to the izle
// companion app through an Android intent link. The invite stays in the fragment, which browsers never send; this page
// sends it nowhere either.

import { appLink, connectTarget } from "./link.js";

const show = () => {
  const target = connectTarget(location);
  const invite = /** @type {HTMLElement} */ (document.getElementById("invite"));
  const none = /** @type {HTMLElement} */ (document.getElementById("no-invite"));
  invite.hidden = target === null;
  none.hidden = target !== null;
  if (target) /** @type {HTMLAnchorElement} */ (document.getElementById("open")).href = appLink(target);
};
addEventListener("hashchange", show);
show();
