# Quinn Writing Studio — Product Overview

Quinn Writing Studio is a personal AI writing coach platform for memoir and essay writers. The primary user is Kevin, an experienced writer. The AI persona "Quinn" acts as a creative partner — she coaches, questions, analyzes, and suggests, but never writes for the user.

## Core Capabilities

- **Coaching Dialogue**: Real-time streaming conversations with Quinn (powered by Anthropic Claude API) with session memory and pattern tracking
- **Studio Tools**: Scrivener .scriv import with change detection, draft versioning with diff comparison, quick capture for ideas, cross-project theme mapping
- **Background Intelligence**: Scheduled jobs scanning for writing grants, AI news (for the Promptly project), and publishing industry developments
- **Accountability**: Goal tracking, writing activity insights, nudge system with escalating check-ins in Quinn's voice

## Key Constraints

- Quinn never writes prose for the user — all writing is the user's own
- The system is built for a single user (Kevin) first, but designed for future multi-tenant productization
- Three active projects: Essay Collection book manuscript, kevinvandever.com/Substack, and Promptly (AI demystification)
- Smart model routing: Claude Sonnet for everyday tasks, Claude Opus for deep analysis
