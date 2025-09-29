const formatHTML = (string: string, tag: string = "p"): string => {
  const formattedString: string = string
    ? `<${tag}>${string.replace(/\n/g, "<br />")}</${tag}>`
    : "";
  return formattedString;
};

export default formatHTML;
