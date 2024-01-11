import chalk from "chalk";
import {
  INugoContext,
  IRegexMarkdownModification,
} from "./plugins/pluginTypes";
import { error, info, logDebug, logDebugFn, verbose, warning } from "./log";
import { NotionPage } from "./NotionPage";
import { INugoConfig } from "./config/configuration";
import { NotionBlock } from "./types";
import { executeWithRateLimitAndRetries } from "./pull";

export async function getMarkdownForPage(
  config: INugoConfig,
  context: INugoContext,
  page: NotionPage
): Promise<string> {
  info(
    `Reading & converting page ${page.layoutContext}/${
      page.nameOrTitle
    } (${chalk.blue(
      page.hasExplicitSlug
        ? page.slug
        : page.foundDirectlyInOutline
        ? "Descendant of Outline, not Database"
        : "NO SLUG"
    )})`
  );

  const blocks = await context.getBlockChildren(page.pageId);

  logDebugFn("markdown from page", () => JSON.stringify(blocks, null, 2));

  // Level page index.md content filter : Keep the block if it is not a child page or only contains a mention (is a link to page)
  // Note: this will filters EVERY page. We assume child_page and mention block to be used only for the purpose of creating a new page.
  // If you want to use links to other pages, you'll have to put a bit of text in the block.
  const filteredBlocks = blocks.filter((block: any) => {
    // Filter out 'child_page' type blocks
    if (block.type === 'child_page') {
      return false;
    }
  
    // Filter out link to page blocks : check if they consist of a mention and an empty text node
    if (block.type === 'paragraph' && block.paragraph.rich_text.length === 2) {
      const [element1, element2] = block.paragraph.rich_text;
  
      // Check for one mention of type 'page' and one empty text node
      const isPageMention = (element: any) => element.type === 'mention' && element.mention?.type === 'page';
      const isEmptyTextNode = (element: any) => element.type === 'text' && element.text?.content.trim() === '';
  
      if ((isPageMention(element1) && isEmptyTextNode(element2)) || (isPageMention(element2) && isEmptyTextNode(element1))) {
        // Filter out this block
        return false;
      }
    }
      return true;
  });

  const body = await getMarkdownFromNotionBlocks(context, config, filteredBlocks);
  const frontmatter = getFrontMatter(page); // todo should be a plugin
  return `${frontmatter}\n${body}`;
}

// this is split off from getMarkdownForPage so that unit tests can provide the block contents
export async function getMarkdownFromNotionBlocks(
  context: INugoContext,
  config: INugoConfig,
  blocks: Array<NotionBlock>
): Promise<string> {

  // changes to the blocks we get from notion API
  doNotionBlockModifications(blocks, config);

  // overrides for the default notion-to-markdown conversions
  registerNotionToMarkdownCustomTransforms(config, context);

  // the main conversion to markdown, using the notion-to-md library
  let markdown = await doNotionToMarkdown(context, blocks); 

  // corrections to links after they are converted to markdown,
  // with access to all the pages we've seen
  markdown = doLinkFixes(context, markdown, config);

  //console.log("markdown after link fixes", markdown);

  // simple regex-based tweaks. These are usually related to docusaurus
  const body = await doTransformsOnMarkdown(context, config, markdown);

  // console.log("markdown after regex fixes", markdown);
  // console.log("body after regex", body);

  //TODO: make this a standalone function
  const uniqueImports = [...new Set(context.imports)];
  const imports = uniqueImports.join("\n");
  context.imports = []; // reset for next page
  return `${imports}\n${body}`;
}

// operations on notion blocks before they are converted to markdown
export function doNotionBlockModifications(
  blocks: Array<NotionBlock>,
  config: INugoConfig
) {
  for (const block of blocks) {
    config.plugins.forEach(plugin => {
      if (plugin.notionBlockModifications) {
        plugin.notionBlockModifications.forEach(transform => {
          logDebug("transforming block with plugin", plugin.name);
          transform.modify(block);
        });
      }
    });
  }
}

// simple regex-based tweaks. These are usually related to docusaurus
async function doTransformsOnMarkdown(
  context: INugoContext,
  config: INugoConfig,
  input: string
) {
  const regexMods: IRegexMarkdownModification[] = config.plugins
    .filter(plugin => !!plugin.regexMarkdownModifications)
    .map(plugin => {
      const mods = plugin.regexMarkdownModifications!;
      // stick the name of the plugin into each mode for logging
      const modsWithNames = mods.map(m => ({ name: plugin.name, ...m }));
      return modsWithNames;
    })
    .flat();

  // regex that matches markdown code blocks
  const codeBlocks = /```.*\n[\s\S]*?\n```/;

  let body = input;
  //console.log("body before regex: " + body);
  let match;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const mod of regexMods) {
    let replacement = undefined;
    // regex.exec is stateful, so we don't want to mess up the plugin's use of its own regex, so we clone it.
    // we also add the "g" flag to make sure we get all matches
    const regex = new RegExp(`${codeBlocks.source}|(${mod.regex.source})`, "g");
    while ((match = regex.exec(input)) !== null) {
      if (match[0]) {
        const original = match[0];
        if (
          original.startsWith("```") &&
          original.endsWith("```") &&
          !mod.includeCodeBlocks
        ) {
          continue; // code block, and they didn't say to include them
        }
        if (mod.getReplacement) {
          // our match here has an extra group, which is an implementation detail
          // that shouldn't be made visible to the plugin
          const matchAsThePluginWouldExpectIt = mod.regex.exec(match[0])!;
          replacement = await mod.getReplacement(
            context,
            matchAsThePluginWouldExpectIt
          );
        } else if (mod.replacementPattern) {
          replacement = mod.replacementPattern.replace("$1", match[2]);
        }
        if (replacement !== undefined) {
          verbose(`[${(mod as any).name}] ${original} --> ${replacement}`);

          const precedingPart = body.substring(0, match.index); // ?
          const partStartingFromThisMatch = body.substring(match.index); // ?
          body =
            precedingPart +
            partStartingFromThisMatch.replace(original, replacement);

          // add any library imports
          if (!context.imports) context.imports = [];
          context.imports.push(...(mod.imports || []));
        }
      }
    }
  }
  logDebug("doTransformsOnMarkdown", "body after regex: " + body);
  return body;
}

export async function doNotionToMarkdown(
  nugoContext: INugoContext,
  blocks: Array<NotionBlock>
) {
  let mdBlocks: any;
  await executeWithRateLimitAndRetries(
    "notionToMarkdown.blocksToMarkdown",
    async () => {
      mdBlocks = await nugoContext.notionToMarkdown.blocksToMarkdown(
        // We need to provide a copy of blocks.
        // Calling blocksToMarkdown can modify the values in the blocks. If it does, and then
        // we have to retry, we end up retrying with the modified values, which
        // causes various issues (like using the transformed image url instead of the original one).
        // Note, currently, we don't do anything else with blocks after this.
        // If that changes, we'll need to figure out a more sophisticated approach.
        JSON.parse(JSON.stringify(blocks))
      );
    }
  );

  const markdown =
    nugoContext.notionToMarkdown.toMarkdownString(mdBlocks).parent || "";
  return markdown;
}

// corrections to links after they are converted to markdown
// Note: from notion (or notion-md?) we get slightly different hrefs depending on whether the links is "inline"
// (has some other text that's been turned into a link) or "raw".
// Raw links come in without a leading slash, e.g. [mention](4a6de8c0-b90b-444b-8a7b-d534d6ec71a4)
// Inline links come in with a leading slash, e.g. [pointer to the introduction](/4a6de8c0b90b444b8a7bd534d6ec71a4)
function doLinkFixes(
  context: INugoContext,
  markdown: string,
  config: INugoConfig
): string {
  const linkRegExp = /\[.*?\]\([^\)]*\)/g;

  logDebug("Markdown before link fix: ", markdown);
  let match: RegExpExecArray | null;

  // since we're going to make changes to the markdown,
  // we need to keep track of where we are in the string as we search
  const markdownToSearch = markdown;

  // The key to understanding this `while` is that linkRegExp actually has state, and
  // it gives you a new one each time. https://stackoverflow.com/a/1520853/723299
  while ((match = linkRegExp.exec(markdownToSearch)) !== null) {
    const originalLinkMarkdown = match[0];

    verbose(
      `Link parsing: Checking "${originalLinkMarkdown}"`
    );

    // We only use the first plugin that matches and makes a change to the link.
    // Enhance: we could take the time to see if multiple plugins match, and
    // and point this out in verbose logging mode.
    config.plugins.some(plugin => {
      if (!plugin.linkModifier) return false;
      if (plugin.linkModifier.match.exec(originalLinkMarkdown) === null) {
        verbose(`Link parsing: [${plugin.name}] Did not match this url`);
        return false;
      }
      const newMarkdown = plugin.linkModifier.convert(
        context,
        originalLinkMarkdown
      );

      if (newMarkdown !== originalLinkMarkdown) {
        markdown = markdown.replace(originalLinkMarkdown, newMarkdown);
        verbose(
          `Link parsing: [${plugin.name}] Converted "${originalLinkMarkdown}" to "${newMarkdown}"`
        );
        return true; // the first plugin that matches and does something wins
      } else {
        verbose(`Link parsing: [${plugin.name}] URL unchanged`);
        return false;
      }
    });
  }
  return markdown;
}

// overrides for the conversions that notion-to-md does
function registerNotionToMarkdownCustomTransforms(
  config: INugoConfig,
  nugoContext: INugoContext
) {
  config.plugins.forEach(plugin => {
    if (plugin.notionToMarkdownTransforms) {
      plugin.notionToMarkdownTransforms.forEach(transform => {
        logDebug(
          "registering custom transform",
          `${plugin.name} for ${transform.type}`
        );
        nugoContext.notionToMarkdown.setCustomTransformer(
          transform.type,
          (block: any) => {
            logDebug(
              "notion to MD conversion of ",
              `${transform.type} with plugin: ${plugin.name}`
            );
            return transform.getStringFromBlock(nugoContext, block);
          }
        );
      });
    }
  });
}

// enhance:make this built-in plugin so that it can be overridden
function getFrontMatter(page: NotionPage): string {
  let frontmatter = "---\n";
  frontmatter += `title: ${page.nameOrTitle.replaceAll(":", "-")}\n`; // I have not found a way to escape colons
  frontmatter += `sidebar_position: ${page.order}\n`;
  frontmatter += `slug: ${page.slug ?? ""}\n`;
  if (page.keywords) frontmatter += `keywords: [${page.keywords}]\n`;
  frontmatter += "---\n\n";

  // TODO/enhance: display this only when needed
  frontmatter += "import Tabs from '@theme/Tabs';\n";
  frontmatter += "import TabItem from '@theme/TabItem';\n";
  return frontmatter;
}
