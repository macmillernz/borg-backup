<?php
/**
 * Shared page header: loads CSS/JS once even though Unraid renders every
 * tab of the plugin into the same document.
 */
if (!defined('BB_HEAD_DONE')) {
  define('BB_HEAD_DONE', true);
  $bbv = function ($f) {
    $p = '/usr/local/emhttp/plugins/borg-backup/' . $f;
    return '/plugins/borg-backup/' . $f . '?v=' . (is_file($p) ? filemtime($p) : 0);
  };
  $bbcsrf = $GLOBALS['var']['csrf_token'] ?? ($var['csrf_token'] ?? '');
  echo '<link type="text/css" rel="stylesheet" href="' . $bbv('assets/borg.css') . '">' . "\n";
  echo '<script src="' . $bbv('assets/borg.js') . '"></script>' . "\n";
  echo '<script src="' . $bbv('assets/wizard.js') . '"></script>' . "\n";
  echo '<script>BB.csrf = ' . json_encode($bbcsrf) . '; BB.ready(BB.start);</script>' . "\n";
}
