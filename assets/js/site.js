/* ============================================================================
   GEM-4D project page behaviour.

   Taken from the Stream3D project page and reduced to the parts this page uses:
   navigation, scroll-spy, reveal-on-scroll and BibTeX copying. The 3D viewer,
   stream player, example loader and GitHub star counter were removed.
   ============================================================================ */

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;

  Object.entries(options.attributes || {}).forEach(([name, value]) => {
    if (value === false || value === null || value === undefined) return;
    element.setAttribute(name, value === true ? "" : String(value));
  });

  return element;
}

function initRevealObserver() {
  const revealElements = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || prefersReducedMotion.matches) {
    revealElements.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.12 });

  revealElements.forEach((element) => observer.observe(element));
}

function initSectionObserver() {
  const sections = [...document.querySelectorAll("[data-section]")];
  const navLinks = [...document.querySelectorAll("[data-nav] a[href^='#']")];
  if (!("IntersectionObserver" in window) || sections.length === 0) return;

  const visibleSections = new Map();
  const setActiveSection = () => {
    const visible = sections.filter((section) => visibleSections.get(section)?.isIntersecting);
    if (visible.length === 0) return;

    visible.sort((first, second) => {
      const firstEntry = visibleSections.get(first);
      const secondEntry = visibleSections.get(second);
      return Math.abs(firstEntry.boundingClientRect.top) - Math.abs(secondEntry.boundingClientRect.top);
    });

    const activeId = visible[0].id;
    navLinks.forEach((link) => {
      const active = link.getAttribute("href") === `#${activeId}`;
      link.classList.toggle("is-active", active);
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => visibleSections.set(entry.target, entry));
    setActiveSection();
  }, {
    rootMargin: "-18% 0px -62% 0px",
    threshold: [0, 0.01],
  });

  sections.forEach((section) => observer.observe(section));
}

function initNavigation() {
  const header = document.querySelector("[data-header]");
  const nav = document.querySelector("[data-nav]");
  const menuButton = document.querySelector("[data-menu-button]");
  if (!header || !nav || !menuButton) return;

  const desktopQuery = window.matchMedia("(min-width: 981px)");

  const setOpen = (open, restoreFocus = false) => {
    nav.classList.toggle("is-open", open);
    header.classList.toggle("nav-open", open);
    document.body.classList.toggle("nav-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");

    if (open) nav.querySelector("a")?.focus();
    else if (restoreFocus) menuButton.focus();
  };

  menuButton.addEventListener("click", () => {
    setOpen(menuButton.getAttribute("aria-expanded") !== "true");
  });
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });
  header.querySelectorAll("a[href^='#']").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") {
      setOpen(false, true);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (menuButton.getAttribute("aria-expanded") === "true" && !header.contains(event.target)) {
      setOpen(false);
    }
  });

  const closeOnDesktop = (event) => {
    if (event.matches) setOpen(false);
  };
  if (typeof desktopQuery.addEventListener === "function") {
    desktopQuery.addEventListener("change", closeOnDesktop);
  } else {
    desktopQuery.addListener(closeOnDesktop);
  }
}

async function writeToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = createElement("textarea", {
    attributes: { readonly: true, "aria-hidden": "true" },
  });
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "-9999px";
  document.body.append(textArea);
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    textArea.remove();
  }

  if (!copied) throw new Error("The browser rejected the copy command.");
}

function initCitationCopy() {
  const button = document.querySelector("[data-copy-citation]");
  const status = document.querySelector("[data-copy-status]");
  const bibtex = document.querySelector("#bibtex");
  if (!button || !status || !bibtex) return;

  const idleLabel = button.textContent.trim();
  let resetTimer = null;
  button.addEventListener("click", async () => {
    if (resetTimer !== null) window.clearTimeout(resetTimer);
    button.disabled = true;
    status.textContent = "Copying BibTeX...";

    try {
      await writeToClipboard(bibtex.textContent.trim());
      button.textContent = "Copied";
      status.textContent = "BibTeX copied to the clipboard.";
    } catch (error) {
      console.error("Unable to copy BibTeX.", error);
      button.textContent = idleLabel;
      status.textContent = "Copy failed. Select the BibTeX text and copy it manually.";
    } finally {
      button.disabled = false;
      button.focus();
      resetTimer = window.setTimeout(() => {
        button.textContent = idleLabel;
        status.textContent = "";
        resetTimer = null;
      }, 3000);
    }
  });
}

function initRolloutPicker() {
  const picker = document.querySelector("[data-rollout-picker]");
  const video = document.querySelector("#wan14b-video");
  const prompt = document.querySelector("#wan14b-prompt");
  if (!picker || !video || !prompt) return;

  picker.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-rollout]");
    if (!button || button.getAttribute("aria-pressed") === "true") return;

    picker.querySelector('[aria-pressed="true"]').setAttribute("aria-pressed", "false");
    button.setAttribute("aria-pressed", "true");
    prompt.textContent = button.querySelector(".case-tab-title").textContent;

    const wasPlaying = !video.paused;
    const source = `./assets/media/wan14b/${button.dataset.rollout}`;
    video.poster = `${source}-poster.jpg`;
    video.src = `${source}.mp4`;
    if (wasPlaying) video.play().catch(() => {});
  });
}

function init() {
  document.documentElement.classList.add("js");
  initNavigation();
  initCitationCopy();
  initRolloutPicker();
  initRevealObserver();
  initSectionObserver();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
