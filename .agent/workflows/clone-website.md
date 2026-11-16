---
description: Rebuild one or more websites as working local code matching their content, assets, responsive layout, and interactions.
---

# Clone Website Workflow

When triggered via `/clone-website` or requested to clone/reverse-engineer a website URL:

## Step 1: Read the Skill
Read the instructions at [.agents/skills/clone-website/SKILL.md](file:///c:/Users/vinh_tran/Downloads/clone/.agents/skills/clone-website/SKILL.md) and its references:
- [inspection-guide.md](file:///c:/Users/vinh_tran/Downloads/clone/.agents/skills/clone-website/references/inspection-guide.md)
- [framer-and-motion.md](file:///c:/Users/vinh_tran/Downloads/clone/.agents/skills/clone-website/references/framer-and-motion.md)

## Step 2: Reconnaissance & Mapping
1. Inspect the source URL using browser tools or direct network inspection.
2. Record route mapping, layouts, fonts, design tokens (colors, spacing), assets, and interactive states.
3. Capture multi-viewport desktop and mobile references.

## Step 3: Foundation & Components
1. Establish global styling, typography, assets, and base layout.
2. Build components matching the observed sections with real content, SVG icons, and responsive behaviors.

## Step 4: Interactions & QA
1. Implement animations, scroll reveals, sticky elements, and state interactions.
2. Compare side-by-side with the live source website and fix layout/rendering differences.
