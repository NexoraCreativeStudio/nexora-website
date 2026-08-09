# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Nexora Creative Studio** - A marketing website and platform documentation system for AI receptionist and growth automation services for UK aesthetic clinics. The codebase consists of static HTML, CSS, and JavaScript files organized as a multi-page marketing site.

## Architecture

### High-Level Structure

```
/
├── index.html              # Main landing page (152KB)
├── luxury-clinic-websites/ # Dedicated service page
│   └── index.html
├── platform/                # Platform product documentation
│   ├── index.html          # Platform overview
│   ├── ai-receptionist/    # AI Receptionist service
│   ├── ai-crm/             # AI CRM system
│   ├── analytics/          # Analytics features
│   ├── automations/        # AI Automations
│   ├── lead-reactivation/  # Lead Reactivation
│   ├── patient-journey/    # Patient Journey workflow
│   └── knowledge-base/     # Knowledge Base
├── assets/
│   ├── css/
│   │   ├── site.css           # Main styles (global, utilities, components)
│   │   ├── design-system.css  # Shared component library
│   │   └── consent.css        # GDPR consent styling
│   └── js/
│       ├── consent-mode.js    # Google Consent Mode integration
│       ├── nav.js             # Navigation and mobile menu
│       ├── vapi-widget.js     # Voice AI widget integration
│       ├── platform-demo.js   # Platform demo interactions
│       └── reveal.js          # Scroll animation helper
├── results/           # Case studies and results
├── design-system/     # Component documentation
├── brand-studio/      # Logo and brand assets
└── brand-guidelines/  # Visual identity specs
```

### Page Types

- **Service Pages** (`/`, `/luxury-clinic-websites/`) - Marketing pages describing clinic website packages
- **Platform Pages** (`/platform/*`) - Product documentation for each platform component
- **Legal Pages** (`cookies.html`, `privacy.html`, `terms.html`) - Compliance documentation

## Development Workflow

### No Build Process
This is a **static HTML website** with no bundler, transpiler, or build step. Changes are directly editable and immediately live when deployed.

### Editing HTML Pages
1. Edit pages directly in their directories (e.g., `/platform/ai-receptionist/index.html`)
2. Content updates typically follow the pattern:
   - `<section class="service-hero">` - Hero sections with title, description, CTAs
   - `<section class="section-head">` - Section headers with `eyebrow`, `h2`, and `p`
   - Feature grids use `<div class="service-feature-card">` pattern
   - Process steps use `<div class="step"><div class="num">01</div>...` pattern

### CSS Editing
- Primary stylesheet: `/assets/css/site.css` (~44KB) - contains all custom styling
- Design system: `/assets/css/design-system.css` - reusable component classes
- Both are plain CSS (no preprocessor)

### JavaScript
- All scripts are vanilla JavaScript in `/assets/js/`
- No module system, no npm dependencies
- Key scripts:
  - `nav.js` - Mobile navigation toggle and dropdown handling
  - `consent-mode.js` - GDPR cookie consent configuration
  - `vapi-widget.js` - Voice AI widget initialization

### Testing
No automated tests are configured. Pages should be tested manually in browsers.

### Linting
No linting tools configured. Files should follow existing patterns from the codebase.

## Deployment

Deploy by uploading the repository contents to a static hosting service (files are served directly from root `/`). The site is currently hosted at `https://nexorastudio.uk/`.

## Key Integration Points

- **Google Tag Manager**: G-Tag ID `G-LWT57YG0B1` in every page head
- **Calendly**: Widget loaded from `assets.calendly.com`
- **VAPI Voice AI**: Custom widget in `assets/js/vapi-widget.js`
- **Fonts**: Inter, IBM Plex Mono, and Fraunces from Google Fonts