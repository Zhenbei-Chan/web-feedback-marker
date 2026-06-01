# Codex for Open Source Application Draft

This document is a working draft for applying to OpenAI Codex for Open Source.

## Project Summary

网页反馈标注器 is a local-first Chrome Manifest V3 extension for webpage review and feedback annotation. It helps content, product, design, QA, and operations teams annotate webpages while browsing, capture local visual evidence, and export structured PDF feedback reports.

The extension supports text feedback, region feedback, and point feedback. It keeps feedback markers visible on the page with minimal interruption, stores all data in `chrome.storage.local`, and does not use AI APIs, cloud sync, accounts, analytics, or third-party tracking.

## Why It Is Useful

Many webpage review workflows still rely on scattered screenshots, chat messages, and manually written feedback documents. This project turns that workflow into a lightweight browser-native process: mark the issue directly on the page, describe the feedback in context, and export a report that includes both text and visual evidence.

## Maintainer Role

I am the primary maintainer of the project. I design the product workflow, maintain the Chrome extension code, verify local installation behavior, and manage the roadmap.

## Suggested Application Answer

I maintain Web Feedback Marker, a local-first Chrome Manifest V3 extension for webpage feedback annotation and PDF export. The project helps reviewers annotate webpages while browsing, add text/region/point feedback, preserve visual evidence, and export structured reports for product, content, design, QA, and engineering collaboration.

The project is privacy-first: it stores feedback, page metadata, and screenshots only in `chrome.storage.local`; it does not use AI APIs, cloud sync, accounts, telemetry, or third-party analytics. The current focus is making webpage review workflows easier for teams that need low-permission, local-only feedback tools.

Codex would help me maintain the project by reviewing browser-extension edge cases, improving PDF export reliability, adding automated regression tests, and keeping the Manifest V3 permission model simple and safe as the project grows.

