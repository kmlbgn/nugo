import { INugoContext, IPlugin } from "../pluginTypes";
import { error, warning, verbose } from "../../log";
import { NotionPage } from "../../NotionPage";

// converts a url to a local link, if it is a link to a page in the Notion site
// only here for plugins, notion won't normally be giving us raw urls.
// If it finds a URL but can't find the page it points to, it will return undefined.
// If it doesn't find a match at all, it returns undefined.
export function convertInternalUrl(
  context: INugoContext,
  url: string
): string | undefined {
  const kGetIDFromNotionURL = /https:\/\/www\.notion\.so\/([a-z0-9]+).*/;
  const match = kGetIDFromNotionURL.exec(url);
  if (match === null) {
    warning(
      `[standardInternalLinkConversion] Could not parse link ${url} as a Notion URL`
    );
    return undefined;
  }
  const id = match[1];
  const pages = context.pages;
  // find the page where pageId matches hrefFromNotion
  const targetPage = pages.find(p => {
    return p.matchesLinkId(id);
  });

  if (!targetPage) {
    // About this situation. See https://github.com/sillsdev/docu-notion/issues/9
    warning(
      `[standardInternalLinkConversion] Could not find the target of this link. Note that links to outline sections are not supported. ${url}. https://github.com/sillsdev/docu-notion/issues/9`
    );
    return undefined;
  }
  // warning(
  //   `[standardInternalLinkConversion] Found the target for ${id}, passing ${url}`
  // );
  return convertLinkHref(context, targetPage, url);
}

// handles the whole markdown link, including the label
function convertInternalLink(
  context: INugoContext,
  markdownLink: string
): string {
  const linkRegExp = /\[([^\]]+)?\]\((?!mailto:)(https:\/\/www\.notion\.so\/[^)]+|\/[^),]+)\)/g;
  const match = linkRegExp.exec(markdownLink);
  if (match === null) {
    warning(
      `[InternalLinkPlugin] Could not parse link ${markdownLink}`
    );
    return markdownLink;
  }

  const labelFromNotion = match[1] || "";
  let hrefFromNotion = match[2];


    // TODO: This is a hotfix to dodge internal image links parsing
    const imageFileExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];
    const isImageLink = imageFileExtensions.some(ext => hrefFromNotion.endsWith(ext));
    if (isImageLink) {
      verbose(`Link parsing: [InternalLinkPlugin] ${hrefFromNotion} is an internal image link and will be skipped. Make sure it exists !`);
      return markdownLink;
    }

  // Find the last occurrence of either '-' or '/' and take everything to the right to extract id and fragment
  const lastSpecialCharIndex = Math.max(hrefFromNotion.lastIndexOf('-'), hrefFromNotion.lastIndexOf('/'));
  if (lastSpecialCharIndex !== -1) {
      hrefFromNotion = hrefFromNotion.substring(lastSpecialCharIndex + 1);
  }

  const pages = context.pages;
  // find the page where pageId matches hrefFromNotion
  const targetPage = pages.find(p => {
    return p.matchesLinkId(hrefFromNotion);
  });

  if (!targetPage) {
    // About this situation. See https://github.com/sillsdev/docu-notion/issues/9
    warning(
      `Link parsing: [InternalLinkPlugin] Could not find a local target for ${hrefFromNotion}. Note that links to other notions pages or outline sections are not supported > https://github.com/sillsdev/docu-notion/issues/9`
    );
    return "**[Problem Internal Link]**";
  }

  const label = convertLinkLabel(targetPage, labelFromNotion);
  const url = convertLinkHref(context, targetPage, hrefFromNotion);
  return `[${label}](${url})`;
}

function convertLinkLabel(targetPage: NotionPage, text: string): string {
  // In Notion, if you just add a link to a page without linking it to any text, then in Notion
  // you see the name of the page as the text of the link. But when Notion gives us that same
  // link, it uses "mention" as the text. So we have to look up the name of the page in
  // order to fix that.;
  if (text !== "mention") return text;
  else return targetPage.nameOrTitle;
}
function convertLinkHref(
  context: INugoContext,
  targetPage: NotionPage,
  url: string
): string {
  let convertedLink = context.layoutStrategy.getLinkPathForPage(targetPage);

  /*****************************
  NOTE: as of this writing, the official Notion API completely drops links
  to headings, unless they are part of a inline link.
  *******************************/

  // Include the fragment (# and after) if it exists
  const { fragmentId } = parseLinkId(url);
 // Log only if fragmentId is not an empty string
  if (fragmentId !== "") {
    verbose(`Link parsing: [InternalLinkPlugin] Parsed ${url} and got Fragment ID: ${fragmentId}`);
  }
  convertedLink += fragmentId;

  //verbose(`Converting Link ${url} --> ${convertedLink}`);
  return convertedLink;
}
// Parse the link ID to replace the base page ID (before the #) with its slug if exists, and replace the fragment (# and after) if exists.
export function parseLinkId(fullLinkId: string): {
  baseLinkId: string; // before the #
  fragmentId: string; // # and after
} {
  const iHash: number = fullLinkId.indexOf("#");
  if (iHash >= 0) {
    return {
      baseLinkId: fullLinkId.substring(0, iHash),
      fragmentId: fullLinkId.substring(iHash),
    };
  }
  return { baseLinkId: fullLinkId, fragmentId: "" };
}

export const standardInternalLinkConversion: IPlugin = {
  name: "InternalLinkPlugin",
  linkModifier: {
    // from notion (or notion-md?) we get slightly different hrefs depending on whether the links is "inline"
    // (has some other text that's been turned into a link) or "raw".
    // Raw links come in without a leading slash, e.g. [mention](4a6de8c0-b90b-444b-8a7b-d534d6ec71a4)
    // Inline links come in with a leading slash, e.g. [pointer to the introduction](/4a6de8c0b90b444b8a7bd534d6ec71a4)
    match: /\[([^\]]+)?\]\((?!mailto:)(https:\/\/www\.notion\.so\/[^)]+|\/[^),]+)\)/,
    convert: convertInternalLink,
  },
};