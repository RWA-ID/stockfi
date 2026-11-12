// Decorative dotted sparkline: columns of dots that rise to the right.
// Purely ornamental; carries no data.
(function () {
  var NS = "http://www.w3.org/2000/svg";
  document.querySelectorAll("svg.dots").forEach(function (svg) {
    var cols = Number(svg.getAttribute("data-cols") || 34);
    var rows = Number(svg.getAttribute("data-rows") || 4);
    var w = 1000, h = rows * 26 + 10;
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("preserveAspectRatio", "xMaxYMax meet");
    var gap = w / cols;
    var r = Math.min(gap * 0.28, 7);
    for (var i = 0; i < cols; i++) {
      var t = i / (cols - 1);
      var n = Math.max(1, Math.round(1 + t * (rows - 1) + Math.sin(i * 1.7) * 0.6));
      for (var j = 0; j < n; j++) {
        var c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", String(gap * i + gap / 2));
        c.setAttribute("cy", String(h - r - 2 - j * (r * 2 + 6)));
        c.setAttribute("r", String(r));
        svg.appendChild(c);
      }
    }
  });
})();
