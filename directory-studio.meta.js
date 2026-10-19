// ==UserScript==
// @name         Directory Studio - 本地目录与文本编辑
// @namespace    local.directory-studio
// @version      1.5.0
// @description  本地目录浏览、图片查看、离线代码编辑与 Markdown/Mermaid 预览；不上传、不自动覆盖原文件。
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
// @resource     editor https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.5.0/editor.js#sha256=b2ceeb0ce1142564a74033cbf80249a5474026ab60fa2550bb5e1a3f75725ecb
// @resource     editorCSS https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.5.0/editor.css#sha256=f7a242fb6237e7603d1b56199ebf3ef2cae6352d4816e3d93c83bff2ab4f63e6
// @resource     markdown https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.5.0/markdown.js#sha256=a4c910a0e261cbdbe65c7b78adda375cacd8050239f441b224fa6fb7c636da9b
// @resource     mermaid https://raw.githubusercontent.com/wuyixiang9/directory-studio/main/resources/1.5.0/mermaid.js#sha256=cb6c5a75602123abd2246945bdeaca83be1a1f3b7465e1a652ff434b49380920
// ==/UserScript==
