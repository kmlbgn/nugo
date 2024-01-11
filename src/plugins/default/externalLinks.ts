import { INugoContext, IPlugin } from "../pluginTypes";
import { error, warning } from "../../log";

export const standardExternalLinkConversion: IPlugin = {
  name: "ExternalLinkPlugin",
  linkModifier: {
    match: /\[.*\]\(http.*\)/,
    convert: (context: INugoContext, markdownLink: string) => {
      const linkRegExp = /\[([^\]]+)?\]\((http.*)\)/;
      const match = linkRegExp.exec(markdownLink);
      if (match === null) {
        error(
          `Link parsing: [ExternalLinkPlugin] Could not parse link ${markdownLink}`
        );
        return markdownLink;
      }
      const label = match[1];
      const url = match[2];
      if (label === "bookmark") {
        const replacement = `[${url}](${url})`;
        warning(
          `Link parsing: [ExternalLinkPlugin] Found Notion "Bookmark" link. In Notion this would show as an embed. The best Nugo can do at the moment is replace "Bookmark" with the actual URL: ${replacement}`
        );
        return replacement;
      }
      return `[${label}](${url})`;
    },
  },
};
