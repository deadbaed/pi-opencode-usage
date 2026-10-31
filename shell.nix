{
  pkgs ? import <nixpkgs> { },
}:

pkgs.mkShellNoCC {
  buildInputs = with pkgs; [
    nixd
    nixfmt

    nodejs_24

    # lsp
    vtsls
    vscode-langservers-extracted
  ];
}
