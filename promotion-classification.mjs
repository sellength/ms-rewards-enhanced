import classification from './promotion-classification.cjs'

export const {
    edgeWebProgress,
    earnKeepEarningIds,
    appProgressFields,
    isCurrentAppDailySetCandidate,
    isInteractiveDailySetDestination,
    isExploreOnBingPromotion,
    isAppInteractivePromotion,
    isTomorrowLockedPromotion,
    isManualKeepEarningPromotion,
    getExploreOnBingStatus,
    selectPcKeepEarningPromotions
} = classification
