(custom-set-variables
 ;; custom-set-variables was added by Custom.
 ;; If you edit it by hand, you could mess it up, so be careful.
 ;; Your init file should contain only one such instance.
 ;; If there is more than one, they won't work right.
 '(ansi-color-names-vector
   ["#242424" "#e5786d" "#95e454" "#cae682" "#8ac6f2" "#333366" "#ccaa8f" "#f6f3e8"])
 '(c-backslash-max-column 80)
 '(column-number-mode t)
 '(css-indent-offset 2)
 '(custom-enabled-themes (quote (alan-darktooth)))
 '(custom-safe-themes
   (quote
    ("9f064861ac4719835f08e4adefb4d65d725c90c5967359e7736bb22a8b40e2bd" "d12c2cae6c13a834084e06a3062d5a27cac7627e0872bd1728d203b46ae6a5bb" default)))
 '(debug-on-error t)
 '(default-frame-alist (quote ((height . 65) (width . 95))))
 '(dropbox-consumer-key "cv0e4vspxk0sdxs")
 '(dropbox-consumer-secret "5qhx7low41d5lmr")
 '(indent-tabs-mode nil)
 '(inhibit-startup-screen t)
 '(js-indent-level 2)
 '(js2-basic-offset 2)
 '(js2-compact-case t)
 '(js2-compact-if t)
 '(js2-compact-while t)
 '(js2-global-externs '("BigUint64Array" "BigInt64Array" "BigInt"))
 '(js2-highlight-level 3)
 '(js2-include-node-externs t)
 '(js2-missing-semi-one-line-override t)
 '(js2-strict-missing-semi-warning nil)
 '(js2-strict-trailing-comma-warning nil)
 '(lua-indent-level 2)
 '(package-selected-packages
   (quote
    (yaml-mode typescript-mode scss-mode rust-mode php-mode markdown-mode js2-mode dropbox darktooth-theme)))
 '(save-place-mode t nil (saveplace))
 '(scroll-bar-mode nil)
 '(scss-compile-at-save nil)
 '(sentence-end-double-space nil)
 '(show-paren-mode t)
 '(size-indication-mode t)
 '(text-mode-hook (quote (turn-on-auto-fill text-mode-hook-identify)))
 '(tool-bar-mode nil)
 '(uniquify-buffer-name-style (quote forward) nil (uniquify)))
(custom-set-faces
 ;; custom-set-faces was added by Custom.
 ;; If you edit it by hand, you could mess it up, so be careful.
 ;; Your init file should contain only one such instance.
 ;; If there is more than one, they won't work right.
 '(default ((t (:family "Ubuntu Mono" :foundry "DAMA" :slant normal :weight normal :height 119 :width normal))))
 '(js2-external-variable-face ((t (:foreground "dark green")))))

(add-to-list 'auto-mode-alist '("\\.lst\\'" . fundamental-mode))
(add-to-list 'auto-mode-alist '("\\.LST\\'" . fundamental-mode))

(add-to-list 'load-path "~/.emacs.d/js2-mode")
(require 'js2-mode)

(add-to-list 'load-path "~/.emacs.d/addons/jade-mode")
(require 'sws-mode)
(require 'jade-mode)
(add-to-list 'auto-mode-alist '("\\.jade\\'" . jade-mode))
(add-to-list 'auto-mode-alist '("\\.pug\\'" . jade-mode))


(load-library "~/.emacs.d/elpa/markdown-mode-2.3/markdown-mode.el")
(add-to-list 'auto-mode-alist '("\\.md\\'" . markdown-mode))
(add-to-list 'auto-mode-alist '("\\.js\\'" . js2-mode))

(load-library "~/.emacs.d/showoff-mode.el")
(add-to-list 'auto-mode-alist '("_slide\\.md\\'" . showoff-mode))
(add-to-list 'auto-mode-alist '("_section\\.md\\'" . showoff-mode))


;; Install MELPA package repository http://melpa.org
(require 'package) ;; You might already have this line
(add-to-list 'package-archives
             '("melpa-stable" . "http://stable.melpa.org/packages/") t)
(when (< emacs-major-version 24)
  ;; For important compatibility libraries like cl-lib
  (add-to-list 'package-archives '("gnu" . "http://elpa.gnu.org/packages/")))
(package-initialize) ;; You might already have this line

;; el-get is a package manager
(add-to-list 'load-path "~/.emacs.d/el-get/el-get")

(unless (require 'el-get nil 'noerror)
  (with-current-buffer
      (url-retrieve-synchronously
       "https://raw.github.com/dimitri/el-get/master/el-get-install.el")
    (goto-char (point-max))
    (eval-print-last-sexp)))

(autoload 'word-count-mode "word-count"
          "Minor mode to count words." t nil)
(global-set-key "\M-+" 'word-count-mode)


(add-to-list 'el-get-recipe-path "~/.emacs.d/el-get-user/recipes")
(el-get 'sync)
(put 'downcase-region 'disabled nil)
(put 'narrow-to-region 'disabled nil)
(put 'upcase-region 'disabled nil)
