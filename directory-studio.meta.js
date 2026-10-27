// ==UserScript==
// @name         Directory Studio - 本地目录与文本编辑
// @namespace    local.directory-studio
// @version      1.6.2
// @description  本地目录浏览、图片查看、离线代码编辑与 Markdown/Mermaid/Markmap 预览；不上传、不自动覆盖原文件。
// @homepageURL  https://github.com/wuyixiang9/directory-studio
// @supportURL   https://github.com/wuyixiang9/directory-studio/issues
// @downloadURL  https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/directory-studio.user.js
// @updateURL    https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/directory-studio.meta.js
// @match        file:///*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_getResourceText
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @sandbox      DOM
// @noframes
// @resource     editor https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.6.2/editor.js#sha256=259c162563b2a0cf6ae78d5d7122779dd833cc74dfc2db0d2cbeef2d5652944c
// @resource     editorCSS https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.6.2/editor.css#sha256=f7a242fb6237e7603d1b56199ebf3ef2cae6352d4816e3d93c83bff2ab4f63e6
// @resource     markdown https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.6.2/markdown.js#sha256=bd96dd1f4189366653f9ca11bf1751cce42632a39468222d728ee38b4ece311a
// @resource     mermaid https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.6.2/mermaid.js#sha256=cb6c5a75602123abd2246945bdeaca83be1a1f3b7465e1a652ff434b49380920
// @resource     markmap https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.6.2/markmap.js#sha256=6cfaf630728ab9f1184e3fa7e367833710da0396c8a9c6e60277a98f1a77fb77
// ==/UserScript==
