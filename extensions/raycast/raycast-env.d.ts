/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Server URL - API server origin, e.g. http://localhost:4317 or https://projects.example.com */
  "serverUrl": string,
  /** Web URL - Optional web app origin; defaults to Server URL. For local development use http://127.0.0.1:5173 */
  "webUrl"?: string,
  /** Personal API Token - Create a personal token in Trestl Settings. Read scope supports browsing; write scope enables creating and editing. */
  "token": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-items` command */
  export type SearchItems = ExtensionPreferences & {}
  /** Preferences accessible in the `create-item` command */
  export type CreateItem = ExtensionPreferences & {}
  /** Preferences accessible in the `my-work` command */
  export type MyWork = ExtensionPreferences & {}
  /** Preferences accessible in the `search-projects` command */
  export type SearchProjects = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `search-items` command */
  export type SearchItems = {
  /** Search work items */
  "query": string
}
  /** Arguments passed to the `create-item` command */
  export type CreateItem = {
  /** Work item title */
  "title": string
}
  /** Arguments passed to the `my-work` command */
  export type MyWork = {}
  /** Arguments passed to the `search-projects` command */
  export type SearchProjects = {}
}
