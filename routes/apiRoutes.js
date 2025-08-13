const express = require('express');
const router = express.Router();
const doController = require('../controllers/doController');
const notificationController = require('../controllers/notificationController');

router.get('/check-do', doController.checkSingleDO);
router.get('/recheck-iswa-null', doController.recheckNullIswaDOs);
router.get('/retry-failed-dos', doController.retryFailedDOs);
router.get('/testwa', notificationController.sendTestNotification);
router.get('/tarikandn', doController.getRnColdspaceData);
router.get('/tarikangr', doController.getgrColdspaceData);
router.get('/send-success-notifications', notificationController.sendSuccessNotifications);

module.exports = router;