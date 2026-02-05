# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a simple React application built with Create React App, designed for deployment on Vercel. The app features a basic interactive button that displays "Hello World!" when clicked.

## Development Commands

- `npm install` - Install project dependencies
- `npm start` - Start development server on http://localhost:3000
- `npm run build` - Build production bundle to `build/` directory
- `npm test` - Run Jest test runner in watch mode
- `npm run eject` - Eject from Create React App (irreversible)

## Architecture

- **Framework**: React 18 with functional components and hooks
- **Build Tool**: Create React App (react-scripts)
- **Entry Point**: `src/index.js` renders `App` component into `public/index.html`
- **Main Component**: `src/App.js` contains the primary application logic with useState for message display
- **Deployment**: Configured for Vercel with `vercel.json` using static build deployment
- **Routing**: Single-page application with client-side routing handled by `vercel.json` routes

## Vercel Configuration

The `vercel.json` configures:
- Static build using `@vercel/static-build` with `build` as output directory
- Cache headers for static assets (1-year cache)
- Fallback routing to `index.html` for SPA behavior